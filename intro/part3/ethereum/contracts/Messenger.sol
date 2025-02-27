// contracts/Messenger.sol
// SPDX-License-Identifier: Apache 2

pragma solidity ^0.8.0;

import "./interfaces/IWormhole.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Messenger is Ownable {
    // Hardcode the Wormhole Core Bridge contract address
    // In a real contract, we would set this in a constructor or Setup
    address a = address(0xC89Ce4735882C9F0f0FE26686c53074E09B0D550);
    IWormhole _wormhole = IWormhole(a);

    mapping(bytes32 => bool) _completedMessages;
    mapping(uint16 => bytes32) _bridgeContracts;

    // sendStr sends bytes to the wormhole.
    function sendStr(bytes memory str, uint32 nonce) public returns (uint64 sequence) {
        sequence = _wormhole.publishMessage(nonce, str, 1);
        return sequence;
    }

    // receiveStr confirms VAA and processes message on the receiving chain.
    // Returns true when bytes are seen first time.
    function receiveBytes(bytes memory encodedVm, uint32 /*nonce*/) public {
        (IWormhole.VM memory vm, bool valid, string memory reason) = _wormhole.parseAndVerifyVM(encodedVm);
        // 1. check wormhole signatures/
        require(valid, reason);

        // 2. Check if emtter chain contract is registered.
        require(verifyBridgeVM(vm), " invalid emitter");   // ??? Can I check emitter here ??

        // 3. Drop duplicate VAA.
        require(!_completedMessages[vm.hash], " message already received");
        _completedMessages[vm.hash] = true;

        // Action place.. Store payload somewhere for later retrieval. [time?? -> bytes]

    }

    // Check if receiveBytes emmiter is actually registered chan.
    function verifyBridgeVM(IWormhole.VM memory vm) internal view returns (bool){
        if(_bridgeContracts[vm.emitterChainId] == vm.emitterAddress) return true;
        return false;
    }
    // We register chain,bridge in [mpn run register] command.
    function registerChain(uint16 chainId_, bytes32 bridgeContract_) public onlyOwner {
        _bridgeContracts[chainId_] = bridgeContract_;
    }

    function wormhole() public view returns (IWormhole) {
        return _wormhole;
    }
}

