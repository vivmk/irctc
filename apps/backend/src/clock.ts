let override: number | null = null;
export const clockNow = () => override ?? Date.now();
export const setClock = (ms: number | null) => {
  override = ms;
};
