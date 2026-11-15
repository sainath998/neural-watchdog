// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test } from "forge-std/Test.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { GuardedVault } from "../src/GuardedVault.sol";
import { NeuralWatchdog } from "../src/NeuralWatchdog.sol";
import { WatchdogModel } from "../src/WatchdogModel.sol";

contract MockSystem {
    bytes[] public payloads;
    uint256 public subs;
    function subscribe(uint256, address, uint256, uint256, uint256, uint256) external { subs++; }
    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}
    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory cfg) external { payloads.push(cfg.payload); }
    function payloadCount() external view returns (uint256) { return payloads.length; }
    function debt(address) external pure returns (uint256) { return 0; }
}

contract MockProxy {
    function deliver(address target, address rvm, bytes memory payload) external returns (bool ok) {
        assembly { mstore(add(payload, 36), rvm) }
        (ok,) = target.call(payload);
    }
    function debt(address) external pure returns (uint256) { return 0; }
    receive() external payable {}
}

contract WatchdogTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant SEPOLIA = 11155111;
    MockSystem sys;
    MockProxy proxy;
    NeuralWatchdog dog;
    GuardedVault vault;
    address operator = address(0x0b);
    uint256 txn = 1;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        sys = MockSystem(SYSTEM);
        proxy = new MockProxy();
        dog = new NeuralWatchdog(SEPOLIA);
        vault = new GuardedVault{ value: 0.01 ether }(IPayable(payable(address(proxy))), address(dog), operator);
        vault.fund{ value: 10 ether }();
        dog.link(address(vault));
        vm.chainId(5318007);
        vm.warp(1_800_000_000);
    }

    /// The operator withdraws on Sepolia; the event is fed to the watchdog like Reactive would.
    function withdraw(address to, uint256 amount) internal returns (bool frozenNow) {
        uint256 before = sys.payloadCount();
        vm.prank(operator);
        vault.withdraw(payable(to), amount);
        IReactive.LogRecord memory r;
        r.chainId = SEPOLIA;
        r.contractAddress = address(vault);
        r.topic0 = uint256(keccak256("Withdrawal(address,uint256,uint256)"));
        r.topic1 = uint256(uint160(to));
        r.data = abi.encode(amount, vault.treasury());
        r.opCode = 2;
        r.txHash = txn++;
        vm.prank(SYSTEM);
        dog.react(r);
        if (sys.payloadCount() > before) {
            assertTrue(proxy.deliver(address(vault), address(dog), sys.payloads(sys.payloadCount() - 1)));
            return true;
        }
        return false;
    }

    function test_modelMatchesTheTrainingScriptBitForBit() public view {
        string memory json = vm.readFile("model/vectors.json");
        for (uint256 i = 0; i < 6; i++) {
            string memory k = string.concat("[", vm.toString(i), "]");
            int256[] memory xs = vm.parseJsonIntArray(json, string.concat(k, ".x"));
            int256 expected = vm.parseJsonInt(json, string.concat(k, ".logit"));
            int256[5] memory x = [xs[0], xs[1], xs[2], xs[3], xs[4]];
            assertEq(WatchdogModel.logit(x), expected);
        }
    }

    function test_normalPayrollNeverFreezes() public {
        address[4] memory staff = [address(0xA11CE), address(0xB0B0), address(0xC4A5), address(0xD1A2)];
        for (uint256 day = 0; day < 20; day++) {
            vm.warp(block.timestamp + 1 hours);
            assertFalse(withdraw(staff[day % 4], 0.05 ether + (day % 3) * 0.01 ether), "payroll should pass");
        }
        assertFalse(vault.frozen());
    }

    function test_oneShotDrainFreezesTheVault() public {
        vm.warp(block.timestamp + 1 hours);
        withdraw(address(0xA11CE), 0.05 ether);
        vm.warp(block.timestamp + 1 hours);
        assertTrue(withdraw(address(0xBAD), 8 ether), "a huge withdrawal should freeze");
        assertTrue(vault.frozen());
        vm.prank(operator);
        vm.expectRevert(GuardedVault.Frozen.selector);
        vault.withdraw(payable(address(0xBAD)), 1 ether);
        assertGt(vault.treasury(), 1.9 ether);
    }

    function test_rapidRepeatedDrainFreezesBeforeItEmptiesTheVault() public {
        for (uint256 i = 0; i < 3; i++) { vm.warp(block.timestamp + 1 hours); withdraw(address(0xA11CE), 0.05 ether); }
        bool froze;
        uint256 n;
        while (!froze && n < 10) {
            vm.warp(block.timestamp + 12);
            froze = withdraw(address(0xBAD), 1.5 ether);
            n++;
        }
        assertTrue(froze);
        assertLt(n, 5, "frozen within a few withdrawals");
        assertGt(vault.treasury(), 3 ether, "most of the treasury saved");
    }

    function test_onlyTheWatchdogCanFreezeAndOnlyTheOwnerCanUnfreeze() public {
        vm.expectRevert();
        vault.freeze(address(dog), 1, 1);
        bytes memory p = abi.encodeWithSignature("freeze(address,int256,uint256)", address(0), int256(1), uint256(1));
        assertFalse(proxy.deliver(address(vault), address(0xEE), p));
        assertTrue(proxy.deliver(address(vault), address(dog), p));
        assertTrue(vault.frozen());
        vm.prank(operator);
        vm.expectRevert(GuardedVault.NotOwner.selector);
        vault.unfreeze(operator);
        vault.unfreeze(address(0x0c));
        assertFalse(vault.frozen());
        assertEq(vault.operator(), address(0x0c));
    }
}
