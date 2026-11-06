// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Public record of independent checks on clearances. Reports arrive from a Chainlink CRE
/// forwarder, after the workflow has re-derived limits, quorum and market itself.
contract ClearanceLedger is Ownable {
    enum Status {
        None,
        Attested,
        Refused
    }

    struct Attestation {
        Status status;
        uint64 at;
        uint32 impactBps;
        bytes32 inputsHash;
    }

    /// @notice The contract allowed to deliver reports: a KeystoneForwarder, or a mock one in simulation.
    address public forwarder;
    /// @notice When set, only this workflow's reports count. Simulation runs report a zero workflow id.
    bytes32 public expectedWorkflowId;

    mapping(bytes32 => Attestation) public attestations;
    uint256 public attestedCount;
    uint256 public refusedCount;

    error NotForwarder(address caller);
    error WrongWorkflow(bytes32 workflowId);
    error InvalidStatus();
    error AlreadyReported(bytes32 digest);

    event ForwarderSet(address indexed forwarder);
    event ExpectedWorkflowSet(bytes32 indexed workflowId);
    event Reported(bytes32 indexed digest, Status status, uint32 impactBps, bytes32 inputsHash);

    constructor(address owner_, address forwarder_) Ownable(owner_) {
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    function setForwarder(address forwarder_) external onlyOwner {
        forwarder = forwarder_;
        emit ForwarderSet(forwarder_);
    }

    function setExpectedWorkflow(bytes32 workflowId) external onlyOwner {
        expectedWorkflowId = workflowId;
        emit ExpectedWorkflowSet(workflowId);
    }

    /// @notice CRE's receiver entry point. Metadata starts with the 32-byte workflow id.
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        if (expectedWorkflowId != bytes32(0)) {
            bytes32 workflowId = metadata.length >= 32 ? bytes32(metadata[:32]) : bytes32(0);
            if (workflowId != expectedWorkflowId) revert WrongWorkflow(workflowId);
        }

        (bytes32 digest, uint8 status, uint32 impactBps, bytes32 inputsHash) =
            abi.decode(report, (bytes32, uint8, uint32, bytes32));
        if (status != uint8(Status.Attested) && status != uint8(Status.Refused)) revert InvalidStatus();
        // A first report stands, so a later one can't quietly flip a refusal.
        if (attestations[digest].status != Status.None) revert AlreadyReported(digest);

        attestations[digest] = Attestation(Status(status), uint64(block.timestamp), impactBps, inputsHash);
        if (Status(status) == Status.Attested) attestedCount++;
        else refusedCount++;
        emit Reported(digest, Status(status), impactBps, inputsHash);
    }

    function isAttested(bytes32 digest) external view returns (bool) {
        return attestations[digest].status == Status.Attested;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // IReceiver.onReport and IERC165.supportsInterface.
        return interfaceId == this.onReport.selector || interfaceId == 0x01ffc9a7;
    }
}
