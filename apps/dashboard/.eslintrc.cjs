/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  extends: [
    "@crypto-bot/eslint-config",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
  ],
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
  settings: { react: { version: "detect" } },
  rules: {
    "react/react-in-jsx-scope": "off",
  },
};
