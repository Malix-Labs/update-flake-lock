import { makeNixCommandArgs } from "./nix.js";
import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import { DetSysAction, inputs } from "detsys-ts";

const EVENT_EXECUTION_FAILURE = "execution_failure";

class UpdateFlakeLockAction extends DetSysAction {
  private rawCommitMessage: string;
  private explicitTrailers: string[];
  private commitMessage: string;
  private commitTrailers: string[];
  private nixOptions: string[];
  private flakeInputs: string[];
  private pathToFlakeDir: string | null;

  constructor() {
    super({
      name: "update-flake-lock",
      fetchStyle: "universal",
      requireNix: "fail",
    });

    this.rawCommitMessage = inputs.getString("commit-msg");
    this.explicitTrailers =
      inputs.getMultilineStringOrNull("commit-trailers") ?? [];
    this.commitMessage = this.rawCommitMessage;
    this.commitTrailers = [];

    this.flakeInputs = inputs.getArrayOfStrings("inputs", "space");
    this.nixOptions = inputs.getArrayOfStrings("nix-options", "space");
    this.pathToFlakeDir = inputs.getStringOrNull("path-to-flake-dir");
  }

  private async parseTrailersWithGit(
    message: string,
    cwd?: string,
  ): Promise<{ cleanMessage: string; extractedTrailers: string[] }> {
    let stdout = "";
    const options: actionsExec.ExecOptions = {
      cwd,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
      input: Buffer.from(message),
      ignoreReturnCode: true,
      silent: true,
    };

    const exitCode = await actionsExec.exec(
      "git",
      ["interpret-trailers", "--parse"],
      options,
    );

    if (exitCode !== 0 || !stdout.trim()) {
      return { cleanMessage: message, extractedTrailers: [] };
    }

    const extractedTrailers = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let cleanMessage = message;
    for (const trailer of extractedTrailers) {
      cleanMessage = cleanMessage.replace(trailer, "");
    }

    return {
      cleanMessage: cleanMessage.trim(),
      extractedTrailers,
    };
  }

  async main(): Promise<void> {
    await this.update();
  }

  // No post phase
  async post(): Promise<void> {}

  async update(): Promise<void> {
    const cwd = this.pathToFlakeDir !== null ? this.pathToFlakeDir : undefined;
    const { cleanMessage, extractedTrailers } = await this.parseTrailersWithGit(
      this.rawCommitMessage,
      cwd,
    );
    this.commitMessage = cleanMessage;

    const combined = [...extractedTrailers, ...this.explicitTrailers]
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    this.commitTrailers = Array.from(new Set(combined));

    // Nix command of this form:
    // nix ${maybe nix options} flake ${"update" or "lock"} ${maybe --update-input flags} --commit-lock-file --commit-lockfile-summary ${commit message}
    // Example commands:
    // nix --extra-substituters https://example.com flake lock --update-input nixpkgs --commit-lock-file --commit-lockfile-summary "updated flake.lock"
    // nix flake update --commit-lock-file --commit-lockfile-summary "updated flake.lock"
    const nixCommandArgs: string[] = makeNixCommandArgs(
      this.nixOptions,
      this.flakeInputs,
      this.commitMessage,
    );

    actionsCore.debug(
      JSON.stringify({
        options: this.nixOptions,
        inputs: this.flakeInputs,
        message: this.commitMessage,
        trailers: this.commitTrailers,
        args: nixCommandArgs,
      }),
    );

    const execOptions: actionsExec.ExecOptions = {
      cwd,
      ignoreReturnCode: true,
    };

    const exitCode = await actionsExec.exec("nix", nixCommandArgs, execOptions);

    if (exitCode !== 0) {
      this.recordEvent(EVENT_EXECUTION_FAILURE, {
        exitCode,
      });
      actionsCore.setFailed(`non-zero exit code of ${exitCode} detected`);
    } else {
      if (this.commitTrailers.length > 0) {
        const trailerArgs = ["commit", "--amend", "--no-edit"];
        for (const trailer of this.commitTrailers) {
          trailerArgs.push("--trailer", trailer);
        }
        const amendExitCode = await actionsExec.exec(
          "git",
          trailerArgs,
          execOptions,
        );
        if (amendExitCode !== 0) {
          actionsCore.setFailed(
            `non-zero exit code of ${amendExitCode} detected while amending git trailers`,
          );
          return;
        }
      }
      actionsCore.info(`flake.lock file was successfully updated`);
    }
  }
}

function main(): void {
  new UpdateFlakeLockAction().execute();
}

main();
