// Only the version: a named import keeps the rest of package.json out of the browser's code.
import { version } from "../../package.json";

/** The Mailroom version this deployment runs (package.json's, built in). */
export const VERSION: string = version;
/** Where Mailroom's code and releases live (forks and copies too: new versions come from here). */
export const UPSTREAM_REPO = "RVP97/mailroom";
export const REPO_URL = `https://github.com/${UPSTREAM_REPO}`;
/** The README's steps for updating a deployment. */
export const UPGRADE_URL = `${REPO_URL}#updating`;
