// Ambient typing for CSS modules. The build doesn't actually transform these
// (consumers do — Vite for the standalone, the host bundler when embedded);
// this declaration just teaches tsc that `styles.foo` is a string.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css';
