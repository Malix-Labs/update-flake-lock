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

    const messageLines = message.split("\n");
    // Protect subject line (line index 0) from being stripped as a trailer
    if (messageLines.length <= 1) {
      return {
        cleanMessage: message,
        extractedTrailers,
      };
    }

    // Multiline message: keep subject (line 0) untouched, strip extracted trailers from body
    const cleanLines = messageLines.filter((line, idx) => {
      if (idx === 0) return true;
      return !extractedTrailers.includes(line.trim());
    });

    return {
      cleanMessage: cleanLines.join("\n").trim(),
      extractedTrailers,
    };
  }

  private async getHeadSha(cwd?: string): Promise<string | null> {
    let stdout = "";
    const options: actionsExec.ExecOptions = {
      cwd,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
      },
      ignoreReturnCode: true,
      silent: true,
    };

    const exitCode = await actionsExec.exec(
      "git",
      ["rev-parse", "HEAD"],
      options,
    );
    if (exitCode === 0 && stdout.trim()) {
      return stdout.trim();
    }
    return null;
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

    // Redact raw trailer values from debug logs to prevent leaking emails or user metadata
    actionsCore.debug(
      JSON.stringify({
        options: this.nixOptions,
        inputs: this.flakeInputs,
        message: this.commitMessage,
        trailerCount: this.commitTrailers.length,
        trailerKeys: this.commitTrailers.map((t) => t.split(":")[0].trim()),
        args: nixCommandArgs,
      }),
    );

    const execOptions: actionsExec.ExecOptions = {
      cwd,
      ignoreReturnCode: true,
    };

    const headBefore = await this.getHeadSha(cwd);

    const exitCode = await actionsExec.exec("nix", nixCommandArgs, execOptions);

    if (exitCode !== 0) {
      this.recordEvent(EVENT_EXECUTION_FAILURE, {
        exitCode,
      });
      actionsCore.setFailed(`non-zero exit code of ${exitCode} detected`);
    } else {
      const headAfter = await this.getHeadSha(cwd);

      // Only amend HEAD if Nix actually created a new commit (headBefore !== headAfter)
      if (
        headBefore !== null &&
        headAfter !== null &&
        headBefore !== headAfter &&
        this.commitTrailers.length > 0
      ) {
        actionsCore.info("Nix update commit created; applying git trailers...");
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
