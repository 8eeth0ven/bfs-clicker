package com.example.inventorydemo;
public interface DemoService {
  @retrofit2.http.GET("items") String list(@retrofit2.http.Query("page") String page);
  @retrofit2.http.GET("items/{id}") String detail(@retrofit2.http.Path("id") String id);
}
