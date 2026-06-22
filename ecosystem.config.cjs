module.exports = {
  apps: [
    {
      name: "taskmate-bot",
      script: "./src/index.ts",
      interpreter: "node_modules/.bin/tsx", // or `dist/index.js` if built
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    }
  ]
};
