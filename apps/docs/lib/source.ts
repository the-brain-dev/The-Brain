import { docs } from "../.source/server";
import { loader } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "https://the-brain.dev/docs",
  source: docs.toFumadocsSource(),
});
