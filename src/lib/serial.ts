// Serialize async tasks: each runs only after the previous settles, so rapid triggers
// (e.g. toggling the mic on/off) can't interleave their media rebuilds. Last-enqueued wins.
export function serial(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {}); // a rejected task must not wedge the chain
    return run;
  };
}
