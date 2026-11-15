/** SDK tools/list normally compiles every output schema. Defer compilation,
 * not validation: the original validator still checks each actual result. */
export function lazyValidator(provider) {
  return {
    getValidator(schema) {
      let compiled;
      return input => {
        compiled ??= provider.getValidator(schema);
        return compiled(input);
      };
    },
  };
}
