/** Public entry point of @akaire/local. */

export { startServer } from "./server.js";
export type { StartServerOptions, RunningServer } from "./server.js";
export { LocalGitAdapter } from "./local-git-adapter.js";
export type { RepoInfo, ResolveUnknownResult } from "./local-git-adapter.js";
export { runGit, runGitOrThrow, decodeUtf8, GitCommandError } from "./git.js";
export type { GitResult, RunGitOptions } from "./git.js";
export { resolveRepoPath, validateRepoPathSyntax, validateRevision } from "./paths.js";
