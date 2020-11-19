// SPDX-License-Identifier: LGPL-3.0-or-later
pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "../GPv2Settlement.sol";

contract GPv2SettlementTestInterface is GPv2Settlement {
    function domainSeparatorTest() public view returns (bytes32) {
        return domainSeparator;
    }
}
