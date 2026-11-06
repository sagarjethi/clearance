// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Local stand-in for an ENSv2 Permissioned Resolver: same `text` read and `setText` write,
/// with writers scoped to one key. Sepolia uses the real resolver.
contract LocalTextResolver {
    address public immutable owner;
    mapping(bytes32 => mapping(string => string)) private records;
    mapping(address => mapping(string => bool)) public canWriteKey;

    error NotAllowed(address writer, string key);

    event TextChanged(bytes32 indexed node, string key, string value);

    constructor(address owner_) {
        owner = owner_;
    }

    function grantKey(address writer, string calldata key) external {
        if (msg.sender != owner) revert NotAllowed(msg.sender, key);
        canWriteKey[writer][key] = true;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external {
        if (msg.sender != owner && !canWriteKey[msg.sender][key]) revert NotAllowed(msg.sender, key);
        records[node][key] = value;
        emit TextChanged(node, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return records[node][key];
    }
}
