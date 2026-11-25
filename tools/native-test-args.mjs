export function nativeTestArgs({ dependencies, output, flags = [] }) {
  return [
    "test",
    "runtime/odin/native",
    "-o:none",
    // SDL Init/Quit share process-global state and must not overlap across tests.
    "-define:ODIN_TEST_THREADS=1",
    `-collection:deps=${dependencies}`,
    `-out:${output}`,
    ...flags,
  ];
}
