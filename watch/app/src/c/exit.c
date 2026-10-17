#include <pebble.h>

// Called from JS through the Alloy FFI (manifest.json "ffi").
void pi_exit(void) {
  window_stack_pop_all(true);
}

int32_t pi_clock_24h(void) {
  return clock_is_24h_style() ? 1 : 0;
}
