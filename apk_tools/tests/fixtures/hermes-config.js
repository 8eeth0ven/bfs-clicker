// Synthetic network configuration for compile-only HBC integration tests.
// Compile with Meta hermesc -emit-binary; never execute this bundle.
globalThis.inventoryFixture = {
  url: "https://api.fixture.invalid/v1/items",
  method: "GET"
};
globalThis.secondInventoryFixture = {
  baseURL: "https://stg.fixture.invalid/",
  path: "/v2/items",
  method: "POST"
};
