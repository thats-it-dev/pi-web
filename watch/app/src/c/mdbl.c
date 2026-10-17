#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

#ifdef PBL_DEBUG
  // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 5120,
    .slot = 31744,
    .chunk = 19456,
    .flags = kModdableCreationFlagDebug,
  };
  moddable_createMachine(&cr);
#else
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 5120,
    .slot = 31744,
    .chunk = 19456,
  };
  moddable_createMachine(&cr);
#endif

  window_destroy(w);
}
