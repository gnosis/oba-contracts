// SPDX-License-Identifier: LGPL-3.0-or-newer
pragma solidity ^0.6.12;

/// @title Gnosis Protocol v2 Authentication interface
/// @author Gnosis Developers
interface GPv2Authentication {
    /// @dev determines whether the provided address is an authenticated solver.
    /// @param prospectiveSolver the address of prospective solver.
    /// @return true when prospectiveSolver is an authenticated solver, otherwise false.
    function isSolver(address prospectiveSolver) external view returns (bool);
}
