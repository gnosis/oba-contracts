import { utils } from "ethers";

/**
 * The salt used when deterministically deploying smart contracts.
 */
export const SALT = utils.formatBytes32String("dev");

/**
 * The contract used to deploy contracts deterministically with CREATE2.
 * The address is chosen by the hardhat-deploy library.
 * It is the same in any EVM-based network.
 *
 * https://github.com/Arachnid/deterministic-deployment-proxy
 */
const DEPLOYER_CONTRACT = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

/**
 * The name of a deployed contract.
 */
export type ContractName = "GPv2AllowListAuthentication" | "GPv2Settlement";

/**
 * Dictionary containing all deployed contract names.
 */
export const CONTRACT_NAMES = {
  authenticator: "GPv2AllowListAuthentication",
  settlement: "GPv2Settlement",
} as const;

// NOTE: Use the compiler to assert that the contract names in the above
// dictionary are correct.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertValidContractNames: Record<string, ContractName> = CONTRACT_NAMES;

/**
 * The deployment args for a contract.
 */
export type DeploymentArguments<
  T extends ContractName
> = T extends "GPv2AllowListAuthentication"
  ? [string]
  : T extends "GPv2Settlement"
  ? [string]
  : never;

/**
 * Computes the deterministic address at which the contract will be deployed.
 * This address does not depend on which network the contract is deployed to.
 *
 * @param contractName Name of the contract for which to find the address.
 * @param deploymentArguments Extra arguments that are necessary to deploy.
 * @returns The address that is expected to store the deployed code.
 */
export async function deterministicDeploymentAddress<C extends ContractName>(
  contractName: C,
  ...deploymentArguments: DeploymentArguments<C>
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { abi, bytecode } = require(getArtifactPath(contractName));
  const contractInterface = new utils.Interface(abi);

  const deployData = utils.hexConcat([
    bytecode,
    contractInterface.encodeDeploy(deploymentArguments),
  ]);

  return utils.getCreate2Address(
    DEPLOYER_CONTRACT,
    SALT,
    utils.keccak256(deployData),
  );
}

function getArtifactPath(contractName: ContractName): string {
  // NOTE: Use `require` to load the contract artifact instead of `getContract`
  // so that we don't need to depend on `hardhat` when using this project as
  // a dependency.
  const artifactsRoot = "../../build/artifacts/";
  return `${artifactsRoot}/src/contracts/${contractName}.sol/${contractName}.json`;
}
