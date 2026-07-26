import { makeNixCommandArgs } from "./nix.js";
import * as actionsCore from "@actions/core";
import * as actionsExec from "@actions/exec";
import { DetSysAction, inputs } from "detsys-ts";

const EVENT_EXECUTION_FAILURE = "execution_failure";

class UpdateFlakeLockAction extends DetSysAction {
  private rawCommitMessage: string;
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
    const explicitTrailers =
      inputs.getMultilineStringOrNull("commit-trailers") ?? [];

    const { cleanMessage, extractedTrailers } = this.parseCommitMessage(
      this.rawCommitMessage,
    );
    this.commitMessage = cleanMessage;

    // Combine explicit trailers and trailers extracted from commit-msg, ignoring empty lines
    const combined = [...extractedTrailers, ...explicitTrailers]
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Deduplicate trailers while preserving order
    this.commitTrailers = Array.from(new Set(combined));

    this.flakeInputs = inputs.getArrayOfStrings("inputs", "space");
    this.nixOptions = inputs.getArrayOfStrings("nix-options", "space");
    this.pathToFlakeDir = inputs.getStringOrNull("path-to-flake-dir");
  }

  private parseCommitMessage(message: string): {
    cleanMessage: string;
    extractedTrailers: string[];
  } {
    const lines = message.split("\n");
    const trailerRegex = /^[A-Za-z0-9-]+:\s+.+/;
    const extractedTrailers: string[] = [];
    const cleanLines: string[] = [];

    for (const line of lines) {
      if (trailerRegex.test(line.trim())) {
        extractedTrailers.push(line.trim());
      } else {
        cleanLines.push(line);
      }
    }

    return {
      cleanMessage: cleanLines.join("\n").trim(),
      extractedTrailers,
    };
  }

  async main(): Promise<void> {
    await this.update();
  }

  // No post phase
  async post(): Promise<void> {}

  async update(): Promise<void> {
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
      cwd: this.pathToFlakeDir !== null ? this.pathToFlakeDir : undefined,
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
