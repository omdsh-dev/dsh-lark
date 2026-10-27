/** CSS Modules resolve to a class-name record through the client bundler. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
