/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: ["@crypto-bot/eslint-config"],
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
  env: { node: true },
};
