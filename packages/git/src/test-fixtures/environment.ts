export function saveEnvironment(...keys: string[]): () => void {
  const saved = keys.map(key => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
