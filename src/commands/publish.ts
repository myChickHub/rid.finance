import path from "path";
import Listr from "listr";
import chalk from "chalk";
import { CommandModule } from "yargs";
// Tasks
import { buildAndUpload } from "../tasks/buildAndUpload";
import { generatePublishTx } from "../tasks/generatePublishTx";
import { createGithubRelease } from "../tasks/createGithubRelease";
// Utils
import { getCurrentLocalVersion } from "../utils/versions/getCurrentLocalVersion";
import { increaseFromApmVersion } from "../utils/versions/increaseFromApmVersion";
import { verifyEthConnection } from "../utils/verifyEthConnection";
import { getInstallDnpLink, getPublishTxLink } from "../utils/getLinks";
import { YargsError } from "../params";
import { CliGlobalOptions, ReleaseType, releaseTypes, TxData } from "../types";
import { createNextBranch } from "../tasks/createNextBranch";
import { printObject } from "../utils/print";

const typesList = releaseTypes.join(" | ");

interface CliCommandOptions extends CliGlobalOptions {
  type?: string;
  provider?: string;
  eth_provider: string;
  content_provider: string;
  developer_address?: string;
  timeout: string;
  upload_to: string;
  github_release?: boolean;
  create_next_branch?: boolean;
  dappnode_team_preset?: boolean;
}

export const publish: CommandModule<CliGlobalOptions, CliCommandOptions> = {
  command: "publish [type]",
  describe:
    "Publish a new version of the package in an Aragon Package Manager Repository",

  builder: yargs =>
    yargs
      // Do not add `.require("type")`, it is verified below
      .positional("type", {
        description: `Semver update type. Can also be provided with env RELEASE_TYPE=[type] or via TRAVIS_TAG=release (patch), TRAVIS_TAG=release/[type]`,
        choices: releaseTypes,
        type: "string"
      })
      .option("provider", {
        alias: "p",
        description: `Specify a provider (overwrittes content_provider and eth_provider): "dappnode" (default), "infura", "http://localhost:8545"`,
        // Must NOT add a default here, so options can overwrite each other in the handler
        // default: "dappnode",
        type: "string"
      })
      .option("eth_provider", {
        description: `Specify an eth provider: "dappnode" (default), "infura", "localhost:5002"`,
        default: "dappnode",
        type: "string"
      })
      .option("content_provider", {
        description: `Specify an ipfs provider: "dappnode" (default), "infura", "http://localhost:8545"`,
        default: "dappnode",
        type: "string"
      })
      .option("developer_address", {
        alias: "a",
        description: `If there is no existing repo for this DNP the publish command needs a developer address. If it is not provided as an option a prompt will request it`,
        type: "string"
      })
      .option("timeout", {
        alias: "t",
        description: `Overrides default build timeout: "15h", "20min 15s", "5000". Specs npmjs.com/package/timestring`,
        default: "60min",
        type: "string"
      })
      .option("upload_to", {
        description: `Specify where to upload the release`,
        choices: ["ipfs", "swarm"],
        default: "ipfs"
      })
      .option("github_release", {
        description: `Publish the release on the Github repo specified in the manifest. Requires a GITHUB_TOKEN ENV to authenticate`,
        type: "boolean"
      })
      .option("create_next_branch", {
        description: `Create the next release branch on the DNP's Github repo. Requires a GITHUB_TOKEN ENV to authenticate`,
        type: "boolean"
      })
      .option("dappnode_team_preset", {
        description: `Specific set of options used for internal DAppNode releases. Caution: options may change without notice.`,
        type: "boolean"
      }),

  handler: async args => {
    const { txData, nextVersion, releaseMultiHash } = await publishHanlder(
      args
    );

    if (!args.silent) {
      const txDataToPrint = {
        To: txData.to,
        Value: txData.value,
        Data: txData.data,
        Gas: txData.gasLimit
      };

      console.log(`
  ${chalk.green(`DNP (DAppNode Package) published (version ${nextVersion})`)} 
  Release hash : ${releaseMultiHash}
  ${getInstallDnpLink(releaseMultiHash)}
  
  ${"You must execute this transaction in mainnet to publish a new version of this DNP."}
  
  ${chalk.gray(
    printObject(txDataToPrint, (key, value) => `  ${key.padEnd(5)} : ${value}`)
  )}
  
  ${"You can also execute this transaction with Metamask by following this pre-filled link"}
  
  ${chalk.cyan(getPublishTxLink(txData))}
  `);
    }
  }
};

/**
 * Common handler for CLI and programatic usage
 */
export async function publishHanlder({
  type,
  provider,
  eth_provider,
  content_provider,
  developer_address,
  timeout,
  upload_to,
  github_release,
  create_next_branch,
  dappnode_team_preset,
  // Global options
  dir,
  silent,
  verbose
}: CliCommandOptions): Promise<{
  txData: TxData;
  nextVersion: string;
  releaseMultiHash: string;
}> {
  // Parse optionsalias: "release",
  let ethProvider = provider || eth_provider;
  let contentProvider = provider || content_provider;
  let uploadTo = upload_to;
  let githubRelease = Boolean(github_release);
  let createNextGithubBranch = Boolean(create_next_branch);
  const developerAddress = developer_address || process.env.DEVELOPER_ADDRESS;
  const userTimeout = timeout;

  const isCi = process.env.CI;
  const tag = process.env.TRAVIS_TAG || process.env.GITHUB_REF;
  const typeFromEnv = process.env.RELEASE_TYPE;

  /**
   * Specific set of options used for internal DAppNode releases.
   * Caution: options may change without notice.
   */
  if (dappnode_team_preset) {
    if (isCi) {
      ethProvider = "infura";
      contentProvider = "http://ipfs.dappnode.io";
      uploadTo = "ipfs";
      // Activate verbose to see logs easier afterwards
      verbose = true;
    }

    githubRelease = true;

    if (
      !process.env.GITHUB_REF ||
      process.env.GITHUB_REF == "refs/heads/master"
    ) {
      createNextGithubBranch = true;
    }
  }

  /**
   * Custom options to pass the type argument
   */
  if (!type && typeFromEnv) {
    type = typeFromEnv as ReleaseType;
  }
  if (!type && tag && tag.includes("release")) {
    type = (tag.split("release/")[1] || "patch") as ReleaseType;
  }

  /**
   * Make sure the release type exists and is correct
   */
  if (!type)
    throw new YargsError(`Missing required argument [type]: ${typesList}`);
  if (!releaseTypes.includes(type as ReleaseType))
    throw new YargsError(
      `Invalid release type "${type}", must be: ${typesList}`
    );

  await verifyEthConnection(ethProvider);

  const publishTasks = new Listr(
    [
      // 1. Fetch current version from APM
      {
        title: "Fetch current version from APM",
        task: async (ctx, task) => {
          let nextVersion;
          try {
            nextVersion = await increaseFromApmVersion({
              type: type as ReleaseType,
              ethProvider,
              dir
            });
          } catch (e) {
            if (e.message.includes("NOREPO"))
              nextVersion = getCurrentLocalVersion({ dir });
            else throw e;
          }
          ctx.nextVersion = nextVersion;
          ctx.buildDir = path.join(dir, `build_${nextVersion}`);
          task.title = task.title + ` (next version: ${nextVersion})`;
        }
      },

      // 2. Build and upload
      {
        title: "Build and upload",
        task: ctx =>
          new Listr(
            buildAndUpload({
              dir,
              buildDir: ctx.buildDir,
              contentProvider,
              uploadTo,
              userTimeout
            }),
            { renderer: verbose ? "verbose" : silent ? "silent" : "default" }
          )
      },

      // 3. Generate transaction
      {
        title: "Generate transaction",
        task: ctx =>
          generatePublishTx({
            dir,
            releaseMultiHash: ctx.releaseMultiHash,
            developerAddress,
            ethProvider,
            verbose,
            silent
          })
      },

      // 4. Create github release
      // [ONLY] add the Release task if requested
      {
        title: "Release on github",
        enabled: () => githubRelease,
        task: ctx =>
          createGithubRelease({
            dir,
            buildDir: ctx.buildDir,
            releaseMultiHash: ctx.releaseMultiHash,
            verbose,
            silent
          })
      },

      // 5. Create create next release branch and open PR
      // [ONLY] if requested
      {
        title: "Start next release cycle",
        enabled: () => createNextGithubBranch,
        task: () =>
          createNextBranch({
            dir,
            verbose,
            silent
          })
      }
    ],
    { renderer: verbose ? "verbose" : silent ? "silent" : "default" }
  );

  const tasksFinalCtx = await publishTasks.run();
  const { txData, nextVersion, releaseMultiHash } = tasksFinalCtx;
  return { txData, nextVersion, releaseMultiHash };
}
