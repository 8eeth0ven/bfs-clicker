/* Synthetic evidence fixture. It performs no network requests. */
__attribute__((used)) const char *inventory_native_url = "@NATIVE_URL@";
__attribute__((used)) const char *inventory_native_method_hint = "GET";
const char *inventory_url(void) { return inventory_native_url; }
