cmake_minimum_required(VERSION 3.22.1)
project(pdfium_bridge)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Header files for PDFium
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/include)

# Prebuilt libpdfium.so imported library
add_library(pdfium SHARED IMPORTED)
set_target_properties(pdfium PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libpdfium.so
)

# Project C++ JNI bridge
add_library(pdfium_bridge SHARED
    pdfium/pdfium_bridge.cpp
)

find_library(log-lib log)
find_library(jnigraphics-lib jnigraphics)

target_link_libraries(pdfium_bridge
    pdfium
    ${log-lib}
    ${jnigraphics-lib}
)

# React Native New Architecture application modules (required for TurboModules & Fabric)
project(appmodules)
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

