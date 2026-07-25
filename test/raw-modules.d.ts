// Type declarations for Vite's `?raw` query in test files.
// Lets `import x from '../schema.sql?raw'` resolve to a string.
declare module '*?raw' {
  const content: string;
  export default content;
}
