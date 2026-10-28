#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  // pebble-ui's machine sizes (see the using-pebble-ui skill): the default
  // 32 kB machine aborts with "memory full". They mirror
  // src/embeddedjs/manifest.json (config.creation). The stack is 1 kB over
  // pebble-ui's 5120: popping back to Home builds its menu inside the slide
  // transition, which overflowed 5120 (5632 was enough). The extra 1 kB
  // comes out of the emulator's mc.xsa ceiling: about 42,100 B with 6144
  // (measured 2026-10-27; it was about 43,000 B at 5120). See watch/README.md.
  moddable_createMachine(&(ModdableCreationRecord){
    .recordSize = sizeof(ModdableCreationRecord),
#ifdef PBL_DEBUG
    // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
    .flags = kModdableCreationFlagDebug,
#endif
    .stack = 6144,
    .slot = 45056,
    .chunk = 21504,
  });

  window_destroy(w);
  return 0;
}
