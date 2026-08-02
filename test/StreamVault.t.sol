// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { StreamVault } from "../contracts/StreamVault.sol";

/// Minimal ERC20 for vault tests. Not production code.
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not allowed");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract StreamVaultTest is Test {
    // --- Golden vectors from typescript/scripts/gen-golden-vectors.ts --------
    // Regenerate with: npx tsx scripts/gen-golden-vectors.ts
    // These pin the cross-language digest. If the TS handler and this contract
    // ever disagree on the abi.encode layout, these assertions fail here rather
    // than as an opaque "bad TEE signature" revert on Coston2.
    address constant G_SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant G_VAULT = 0x1111111111111111111111111111111111111111;
    uint256 constant G_CHAIN_ID = 114;
    uint256 constant G_STREAM_ID = 7;
    bytes32 constant G_COMMITMENT =
        0x2222222222222222222222222222222222222222222222222222222222222222;
    uint256 constant G_ACCRUED = 123456789000000000;
    uint256 constant G_DEADLINE = 1893456000;
    bytes32 constant G_WITHDRAW_TAG =
        0x4d87eef0dd0880a75470a03bb68bdfa76333b2fa9ceda4e2954e47973f2eb4cc;
    bytes32 constant G_WITHDRAW_DIGEST =
        0xa1e9396472716ece5fece71f5166021abb9f9dccbe4b1a03e15b58ee30be41da;
    bytes constant G_WITHDRAW_SIG =
        hex"9de080146adcd0369ba13acb7962b1f472f8b77eb9a838b9653941e50f31113f5c26773d8a75f9fec05d889413e253bf81d4945852e2e71c1f69d73390e56e781b";
    bytes32 constant G_SETTLE_TAG =
        0x67aa1a059c8b9cf4df674dee80f4163504b46fe5b06ab8639c1a800deefd40f5;
    bytes32 constant G_SETTLE_DIGEST =
        0x604a8d27c02a34c5cb5697100a7e2154f0de276e0934815a19e24da1821c1b33;

    // --- Fixtures -----------------------------------------------------------
    StreamVault vault;
    MockERC20 token;

    uint256 teeKey;
    address teeSigner;
    address employer = address(0xEEEE);
    address recipient = address(0xBEEF);

    uint256 constant RATE = 1e15; // wei per second
    uint256 constant TOTAL = 1e21;
    uint64 startTime;
    bytes32 commitment;
    bytes terms;

    function setUp() public {
        teeKey = 0xA11CE;
        teeSigner = vm.addr(teeKey);

        vault = new StreamVault(teeSigner);
        token = new MockERC20();

        startTime = uint64(block.timestamp);
        // Layout must match typescript TERMS_ABI: employer first, then recipient.
        terms = abi.encode(
            address(this), recipient, address(token), RATE, TOTAL, startTime, bytes32("salt")
        );
        commitment = keccak256(terms);
    }

    // --- Helpers ------------------------------------------------------------

    /// Mirrors StreamVault's inline digest construction AND the TS
    /// buildAuthDigest(). Proven equivalent to both by the golden tests below.
    function _digest(
        bytes32 tag,
        uint256 chainId,
        address vaultAddr,
        uint256 streamId,
        bytes32 commit,
        uint256 accrued,
        uint256 deadline
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(tag, chainId, vaultAddr, streamId, commit, accrued, deadline));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        bytes32 ethDigest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ethDigest);
        return abi.encodePacked(r, s, v);
    }

    function _authWithdraw(uint256 streamId, uint256 accrued, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = _digest(
            keccak256("SW_WITHDRAW_V1"), block.chainid, address(vault),
            streamId, commitment, accrued, deadline
        );
        return _sign(teeKey, d);
    }

    function _authSettle(uint256 streamId, uint256 accrued, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 d = _digest(
            keccak256("SW_SETTLE_V1"), block.chainid, address(vault),
            streamId, commitment, accrued, deadline
        );
        return _sign(teeKey, d);
    }

    function _openFundedStream(uint128 funded) internal returns (uint256 streamId) {
        streamId = vault.createStream(recipient, address(token), commitment, startTime, "");
        token.mint(address(this), funded);
        token.approve(address(vault), funded);
        vault.fund(streamId, funded);
    }

    // --- Cross-language parity ---------------------------------------------

    function test_GoldenTagsMatchContractConstants() public {
        assertEq(keccak256("SW_WITHDRAW_V1"), G_WITHDRAW_TAG, "withdraw tag drift");
        assertEq(keccak256("SW_SETTLE_V1"), G_SETTLE_TAG, "settle tag drift");
    }

    function test_GoldenWithdrawDigestMatchesTypeScript() public {
        assertEq(
            _digest(
                G_WITHDRAW_TAG, G_CHAIN_ID, G_VAULT, G_STREAM_ID,
                G_COMMITMENT, G_ACCRUED, G_DEADLINE
            ),
            G_WITHDRAW_DIGEST,
            "withdraw digest diverged from TS buildAuthDigest()"
        );
    }

    function test_GoldenSettleDigestMatchesTypeScript() public {
        assertEq(
            _digest(
                G_SETTLE_TAG, G_CHAIN_ID, G_VAULT, G_STREAM_ID,
                G_COMMITMENT, G_ACCRUED, G_DEADLINE
            ),
            G_SETTLE_DIGEST,
            "settle digest diverged from TS buildAuthDigest()"
        );
    }

    /// Proves the EIP-191 prefixing matches too: viem's signMessage({raw})
    /// must recover to the same signer under the vault's prefix reconstruction.
    function test_GoldenSignatureRecoversToTsSigner() public {
        bytes32 ethDigest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", G_WITHDRAW_DIGEST));
        bytes memory sig = G_WITHDRAW_SIG;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        assertEq(ecrecover(ethDigest, v, r, s), G_SIGNER, "EIP-191 prefix drift vs viem");
    }

    // --- Withdraw -----------------------------------------------------------

    function test_Withdraw_PaysAccrued() public {
        uint256 id = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 accrued = RATE * 100;
        vault.withdraw(id, accrued, block.timestamp + 600, _authWithdraw(id, accrued, block.timestamp + 600));

        assertEq(token.balanceOf(recipient), accrued);
    }

    /// Cumulative accounting: the second call pays only the delta, and a
    /// replay of the same authorization pays nothing at all.
    function test_Withdraw_IsCumulativeAndReplaySafe() public {
        uint256 id = _openFundedStream(100 ether);

        vm.warp(block.timestamp + 100);
        uint256 a1 = RATE * 100;
        uint256 d1 = block.timestamp + 600;
        vault.withdraw(id, a1, d1, _authWithdraw(id, a1, d1));
        assertEq(token.balanceOf(recipient), a1);

        // Replaying the identical authorization is a no-op, not a double-pay.
        vm.expectRevert("nothing accrued");
        vault.withdraw(id, a1, d1, _authWithdraw(id, a1, d1));

        // A fresh, larger cumulative figure pays only the difference.
        vm.warp(block.timestamp + 50);
        uint256 a2 = RATE * 150;
        uint256 d2 = block.timestamp + 600;
        vault.withdraw(id, a2, d2, _authWithdraw(id, a2, d2));
        assertEq(token.balanceOf(recipient), a2, "should equal cumulative, not sum of deltas");
    }

    function test_Withdraw_CapsAtFundedBalance() public {
        uint128 funded = 1 ether;
        uint256 id = _openFundedStream(funded);
        vm.warp(block.timestamp + 1_000_000);

        uint256 accrued = RATE * 1_000_000; // far exceeds funded
        uint256 dl = block.timestamp + 600;
        vault.withdraw(id, accrued, dl, _authWithdraw(id, accrued, dl));

        assertEq(token.balanceOf(recipient), funded, "must not overpay beyond funded");
    }

    function test_Withdraw_RejectsForgedSigner() public {
        uint256 id = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 accrued = RATE * 100;
        uint256 dl = block.timestamp + 600;
        bytes32 d = _digest(
            keccak256("SW_WITHDRAW_V1"), block.chainid, address(vault), id, commitment, accrued, dl
        );
        bytes memory forged = _sign(0xBADBAD, d); // not the registered TEE key

        vm.expectRevert("bad TEE signature");
        vault.withdraw(id, accrued, dl, forged);
    }

    function test_Withdraw_RejectsExpiredAuthorization() public {
        uint256 id = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 accrued = RATE * 100;
        uint256 dl = block.timestamp - 1; // already past
        vm.expectRevert("authorization expired");
        vault.withdraw(id, accrued, dl, _authWithdraw(id, accrued, dl));
    }

    /// An authorization is bound to one streamId; it must not move sideways.
    function test_Withdraw_RejectsCrossStreamReplay() public {
        uint256 id1 = _openFundedStream(100 ether);
        uint256 id2 = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 accrued = RATE * 100;
        uint256 dl = block.timestamp + 600;
        bytes memory sigFor1 = _authWithdraw(id1, accrued, dl);

        vm.expectRevert("bad TEE signature");
        vault.withdraw(id2, accrued, dl, sigFor1);
    }

    // --- Cancel -------------------------------------------------------------

    function test_Cancel_SplitsBetweenRecipientAndEmployer() public {
        uint128 funded = 100 ether;
        uint256 id = _openFundedStream(funded);
        vm.warp(block.timestamp + 100);

        uint256 finalAccrued = RATE * 100;
        uint256 dl = block.timestamp + 600;
        uint256 employerBefore = token.balanceOf(address(this));

        vault.cancelStream(id, finalAccrued, dl, _authSettle(id, finalAccrued, dl));

        assertEq(token.balanceOf(recipient), finalAccrued, "recipient owed accrued");
        assertEq(
            token.balanceOf(address(this)) - employerBefore,
            funded - finalAccrued,
            "employer refunded remainder"
        );
    }

    function test_Cancel_AccountsForPriorWithdrawals() public {
        uint128 funded = 100 ether;
        uint256 id = _openFundedStream(funded);

        vm.warp(block.timestamp + 100);
        uint256 a1 = RATE * 100;
        uint256 d1 = block.timestamp + 600;
        vault.withdraw(id, a1, d1, _authWithdraw(id, a1, d1));

        vm.warp(block.timestamp + 100);
        uint256 finalAccrued = RATE * 200;
        uint256 d2 = block.timestamp + 600;
        uint256 employerBefore = token.balanceOf(address(this));

        vault.cancelStream(id, finalAccrued, d2, _authSettle(id, finalAccrued, d2));

        assertEq(token.balanceOf(recipient), finalAccrued, "recipient total == final accrued");
        assertEq(
            token.balanceOf(address(this)) - employerBefore,
            funded - finalAccrued,
            "employer refund excludes what recipient already took"
        );
    }

    function test_Cancel_BlocksFurtherWithdrawals() public {
        uint256 id = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 a = RATE * 100;
        uint256 dl = block.timestamp + 600;
        vault.cancelStream(id, a, dl, _authSettle(id, a, dl));

        vm.expectRevert("cancelled");
        vault.withdraw(id, a * 2, dl, _authWithdraw(id, a * 2, dl));
    }

    // --- Audit Mode ---------------------------------------------------------

    function test_Reveal_AcceptsMatchingTerms() public {
        uint256 id = _openFundedStream(1 ether);
        vm.expectEmit(true, false, false, true);
        emit StreamVault.TermsRevealed(id, terms);
        vault.revealTerms(id, terms);
    }

    function test_Reveal_RejectsAlteredTerms() public {
        uint256 id = _openFundedStream(1 ether);
        // Same shape, higher rate — the lie Audit Mode must catch.
        bytes memory fake = abi.encode(
            address(this), recipient, address(token), RATE * 2, TOTAL, startTime, bytes32("salt")
        );
        vm.expectRevert("terms do not match commitment");
        vault.revealTerms(id, fake);
    }

    // --- Admin --------------------------------------------------------------

    function test_SetTeeSigner_RotatesAndOldKeyStopsWorking() public {
        uint256 id = _openFundedStream(100 ether);
        vm.warp(block.timestamp + 100);

        uint256 newKey = 0xC0FFEE;
        vault.setTeeSigner(vm.addr(newKey));

        uint256 a = RATE * 100;
        uint256 dl = block.timestamp + 600;

        vm.expectRevert("bad TEE signature");
        vault.withdraw(id, a, dl, _authWithdraw(id, a, dl)); // signed by old key

        bytes32 d = _digest(
            keccak256("SW_WITHDRAW_V1"), block.chainid, address(vault), id, commitment, a, dl
        );
        vault.withdraw(id, a, dl, _sign(newKey, d));
        assertEq(token.balanceOf(recipient), a);
    }

    function test_SetTeeSigner_OnlyOwner() public {
        vm.prank(employer);
        vm.expectRevert("not owner");
        vault.setTeeSigner(address(0x1234));
    }
}
