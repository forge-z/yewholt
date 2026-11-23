import { join, resolve } from "node:path";
import { providerHome } from "./target.js";

export const runtimeHome = () => join(resolve(providerHome()), "buzz-runtime");
export const runtimeBridge = join("dist", "provider", "bridge.js");
