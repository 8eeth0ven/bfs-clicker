/* Synthetic fixture; no application code is loaded or executed by the tests. */
extern void *curl_easy_init(void);
__attribute__((used, visibility("default")))
const char *Java_com_example_inventory_Native_endpoint(void) {
    return "https://native.example.test/v1/items?token=synthetic-native-secret&page=1";
}
__attribute__((used, visibility("default")))
const char *inventory_utf16_marker = "https://native.example.test/v1/status";
__attribute__((used, visibility("default")))
const char *inventory_method_decoy = "POST";
__attribute__((used, visibility("default")))
void *inventory_network_symbol(void) { return curl_easy_init(); }
