export default async function(func: () => any, retries: number = 3) {
  for (let i = 0; i < retries; ++i) {
    try {
      return await func();
    } catch(err) {
      if (err.name.startsWith('DiscordRESTError') || i === retries - 1) {
        throw err;
      }
    }
  }
}
