import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  await readFile(new URL("../schema/uzjam-profile.schema.json", import.meta.url), "utf8"),
);
const example = JSON.parse(
  await readFile(new URL("../examples/he1000-reference.uzjam.json", import.meta.url), "utf8"),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

if (!validate(example)) {
  console.error(validate.errors);
  process.exitCode = 1;
} else {
  console.log("Canonical profile schema validation passed.");
}
