# Contributing

Issues and focused pull requests are welcome.

Please keep the plugin project-local and auditable. Features that require a hosted account, silently persist chat history, or bypass the DeepSeek Harness sandbox are intentionally out of scope.

Before opening a pull request:

```sh
npm test
npm run check
```

If you test against a DeepSeek Harness runtime not listed in the README, include the runtime version, OS, and whether the plugin loaded successfully.
