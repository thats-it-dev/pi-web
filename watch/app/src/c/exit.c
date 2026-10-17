#include <pebble.h>

// Called from JS through the Alloy FFI (manifest.json "ffi").
void pi_exit(void) {
  window_stack_pop_all(true);
}
