// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// Minimal ERC20 surface — avoids pulling OpenZeppelin into the scaffold.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title StreamVault
/// @notice Confidential payment streaming vault for StealthWage.
///
/// Stream terms (rate, total, salt) never appear on-chain in plaintext. The
/// vault stores only a keccak256 commitment; the ECIES-encrypted terms blob is
/// emitted once in the StreamCreated event so the TEE extension can reload it
/// on demand. Withdrawals require a signature from the registered TEE signer
/// over (chainId, vault, streamId, commitment, cumulativeAccrued, deadline).
///
/// Accounting is CUMULATIVE: the TEE signs total-accrued-since-start, and the
/// vault pays out (accrued - alreadyWithdrawn). Replaying an old authorization
/// is therefore harmless — it authorizes nothing new. The signed digest binds
/// the commitment, so the TEE never needs to read chain state: a forged
/// terms/commitment pair yields a signature that fails the on-chain
/// commitment check.
///
/// Terms encoding the TEE expects (see typescript/src/app/streamHandlers.ts):
///   abi.encode(address employer, address recipient, address token,
///              uint256 ratePerSecond, uint256 total, uint64 startTime,
///              bytes32 salt)
/// The salt is mandatory — rates are low-entropy and an unsalted commitment
/// could be brute-forced from the explorer.
///
/// `employer` and `recipient` are in the blob so the enclave can authenticate
/// callers: it never reads chain state, so the terms are its only source of
/// truth about who the parties are. `ratePerSecond` is fixed-point, scaled by
/// 1e12 — this contract never interprets it, it only ever sees the resulting
/// cumulativeAccrued.
contract StreamVault {
    struct Stream {
        address employer;
        address recipient;
        address token;
        bytes32 commitment;
        uint128 funded;
        uint128 withdrawn;
        uint64 startTime;
        bool cancelled;
    }

    bytes32 private constant WITHDRAW_TAG = keccak256("SW_WITHDRAW_V1");
    bytes32 private constant SETTLE_TAG = keccak256("SW_SETTLE_V1");

    address public owner;
    address public teeSigner;
    uint256 public nextStreamId = 1;
    mapping(uint256 => Stream) public streams;

    uint256 private _entered = 1;

    event StreamCreated(
        uint256 indexed streamId,
        address indexed employer,
        address indexed recipient,
        address token,
        bytes32 commitment,
        uint64 startTime,
        bytes encryptedTerms
    );
    event StreamFunded(uint256 indexed streamId, uint256 amount);
    event Withdrawn(uint256 indexed streamId, address indexed recipient, uint256 amount);
    event StreamCancelled(uint256 indexed streamId, uint256 refunded);
    event TermsRevealed(uint256 indexed streamId, bytes terms);
    event TeeSignerUpdated(address indexed newSigner);

    modifier nonReentrant() {
        require(_entered == 1, "reentrancy");
        _entered = 2;
        _;
        _entered = 1;
    }

    constructor(address _teeSigner) {
        owner = msg.sender;
        teeSigner = _teeSigner;
    }

    /// @notice Rotate the TEE signer (e.g. after re-registering the machine).
    function setTeeSigner(address _teeSigner) external {
        require(msg.sender == owner, "not owner");
        require(_teeSigner != address(0), "zero signer");
        teeSigner = _teeSigner;
        emit TeeSignerUpdated(_teeSigner);
    }

    /// @notice Open a stream. Terms stay encrypted; only the commitment is stored.
    /// @param _encryptedTerms ECIES ciphertext of the terms, encrypted to the
    ///        TEE's public key. Stored in the event log only, never in state.
    function createStream(
        address _recipient,
        address _token,
        bytes32 _commitment,
        uint64 _startTime,
        bytes calldata _encryptedTerms
    ) external returns (uint256 streamId) {
        require(_recipient != address(0), "zero recipient");
        require(_token != address(0), "zero token");
        require(_commitment != bytes32(0), "zero commitment");

        streamId = nextStreamId++;
        streams[streamId] = Stream({
            employer: msg.sender,
            recipient: _recipient,
            token: _token,
            commitment: _commitment,
            funded: 0,
            withdrawn: 0,
            startTime: _startTime,
            cancelled: false
        });

        emit StreamCreated(
            streamId, msg.sender, _recipient, _token, _commitment, _startTime, _encryptedTerms
        );
    }

    /// @notice Top up a stream. Anyone may fund; typically the employer.
    function fund(uint256 _streamId, uint128 _amount) external nonReentrant {
        Stream storage s = streams[_streamId];
        require(s.employer != address(0), "no stream");
        require(!s.cancelled, "cancelled");
        require(_amount > 0, "zero amount");
        s.funded += _amount;
        require(IERC20(s.token).transferFrom(msg.sender, address(this), _amount), "transferFrom failed");
        emit StreamFunded(_streamId, _amount);
    }

    /// @notice Withdraw accrued funds with a TEE authorization.
    /// @param _cumulativeAccrued Total accrued since stream start, as computed
    ///        and signed by the TEE. The vault pays the delta vs. withdrawn.
    function withdraw(
        uint256 _streamId,
        uint256 _cumulativeAccrued,
        uint256 _deadline,
        bytes calldata _signature
    ) external nonReentrant {
        Stream storage s = streams[_streamId];
        require(s.employer != address(0), "no stream");
        require(!s.cancelled, "cancelled");
        require(block.timestamp <= _deadline, "authorization expired");

        bytes32 digest = keccak256(
            abi.encode(
                WITHDRAW_TAG, block.chainid, address(this), _streamId,
                s.commitment, _cumulativeAccrued, _deadline
            )
        );
        require(_recoverEthSigned(digest, _signature) == teeSigner, "bad TEE signature");

        uint256 cap = _cumulativeAccrued < s.funded ? _cumulativeAccrued : s.funded;
        require(cap > s.withdrawn, "nothing accrued");
        uint256 payout = cap - s.withdrawn;
        // casting to 'uint128' is safe: cap <= s.funded, which is uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        s.withdrawn = uint128(cap);

        require(IERC20(s.token).transfer(s.recipient, payout), "transfer failed");
        emit Withdrawn(_streamId, s.recipient, payout);
    }

    /// @notice Cancel a stream with a TEE-signed final settlement. Pays the
    ///         recipient what accrued up to cancellation, refunds the employer
    ///         the rest.
    function cancelStream(
        uint256 _streamId,
        uint256 _finalAccrued,
        uint256 _deadline,
        bytes calldata _signature
    ) external nonReentrant {
        Stream storage s = streams[_streamId];
        require(msg.sender == s.employer, "not employer");
        require(!s.cancelled, "cancelled");
        require(block.timestamp <= _deadline, "authorization expired");

        bytes32 digest = keccak256(
            abi.encode(
                SETTLE_TAG, block.chainid, address(this), _streamId,
                s.commitment, _finalAccrued, _deadline
            )
        );
        require(_recoverEthSigned(digest, _signature) == teeSigner, "bad TEE signature");

        s.cancelled = true;
        uint256 owed = _finalAccrued < s.funded ? _finalAccrued : s.funded;
        uint256 toRecipient = owed > s.withdrawn ? owed - s.withdrawn : 0;
        uint256 refund = s.funded - s.withdrawn - toRecipient;
        // casting to 'uint128' is safe: owed <= s.funded, which is uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        s.withdrawn = uint128(owed > s.withdrawn ? owed : s.withdrawn);

        if (toRecipient > 0) {
            require(IERC20(s.token).transfer(s.recipient, toRecipient), "transfer failed");
        }
        if (refund > 0) {
            require(IERC20(s.token).transfer(s.employer, refund), "refund failed");
        }
        emit StreamCancelled(_streamId, refund);
    }

    /// @notice Audit Mode: voluntarily reveal the plaintext terms. Anyone
    ///         holding the plaintext (employer or recipient) can prove on-chain
    ///         that these are the real terms — confidential during operation,
    ///         verifiable afterward.
    function revealTerms(uint256 _streamId, bytes calldata _terms) external {
        Stream storage s = streams[_streamId];
        require(s.employer != address(0), "no stream");
        require(keccak256(_terms) == s.commitment, "terms do not match commitment");
        emit TermsRevealed(_streamId, _terms);
    }

    function _recoverEthSigned(bytes32 _digest, bytes calldata _sig) private pure returns (address) {
        require(_sig.length == 65, "bad sig length");
        bytes32 ethDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _digest));
        bytes32 r = bytes32(_sig[0:32]);
        bytes32 vs = bytes32(_sig[32:64]);
        uint8 v = uint8(_sig[64]);
        if (v < 27) v += 27;
        address signer = ecrecover(ethDigest, v, r, vs);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
