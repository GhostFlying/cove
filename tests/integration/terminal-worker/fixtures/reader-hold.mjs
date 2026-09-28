if (!process.argv[2] || !process.send) process.exit(64);
process.on("message", () => {});
setInterval(() => {}, 1000);
