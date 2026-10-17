#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

  moddable_createMachine(&(ModdableCreationRecord){
    .recordSize = sizeof(ModdableCreationRecord),
#ifdef PBL_DEBUG
    // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
    .flags = kModdableCreationFlagDebug,
#endif
    .stack = 5120,
    .slot = 40960,
    .chunk = 19456,
    .fxBuildFFI = fxBuildFFI,
  });

  window_destroy(w);
  return 0;
}
