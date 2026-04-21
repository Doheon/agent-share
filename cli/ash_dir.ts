import { join } from "node:path";
import { homedir } from "node:os";

export const ASH_DIR = process.env.ASH_DIR ?? join(homedir(), ".ash");
