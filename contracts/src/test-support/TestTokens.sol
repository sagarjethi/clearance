// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A plain token: fixed supply, no admin functions.
contract PlainToken is ERC20 {
    constructor(string memory name_, string memory symbol_, address holder, uint256 supply) ERC20(name_, symbol_) {
        _mint(holder, supply);
    }
}

/// @notice A token an owner can drain holders of. The bytecode rule must flag this.
contract RugToken is ERC20 {
    address public owner;
    mapping(address => bool) public isBlacklisted;

    constructor(address holder, uint256 supply) ERC20("Rug Token", "RUG") {
        owner = holder;
        _mint(holder, supply);
    }

    function blacklist(address holder) external {
        require(msg.sender == owner, "not owner");
        isBlacklisted[holder] = true;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from], "blacklisted");
        super._update(from, to, value);
    }
}
