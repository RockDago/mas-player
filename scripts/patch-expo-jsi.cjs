const fs = require('fs');
const path = require('path');

console.log('[patch-expo-jsi] Starting patch for ExpoModulesJSI Swift 6.2 compatibility...');

// 1. Patch RuntimeScheduler.h (removes SWIFT_RETURNS_RETAINED on constructors)
const runtimeSchedulerPath = path.resolve(__dirname, '../node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h');
if (fs.existsSync(runtimeSchedulerPath)) {
  let content = fs.readFileSync(runtimeSchedulerPath, 'utf8');
  if (content.includes('SWIFT_RETURNS_RETAINED RuntimeScheduler')) {
    content = content.replace(/SWIFT_RETURNS_RETAINED RuntimeScheduler/g, 'RuntimeScheduler');
    fs.writeFileSync(runtimeSchedulerPath, content, 'utf8');
    console.log('[patch-expo-jsi] Successfully patched RuntimeScheduler.h');
  } else {
    console.log('[patch-expo-jsi] RuntimeScheduler.h already patched.');
  }
} else {
  console.log('[patch-expo-jsi] RuntimeScheduler.h not found, skipping.');
}

// 2. Patch JavaScriptRuntime.swift (fixes sending ... risks causing data races without nil crashes)
const jsRuntimePath = path.resolve(__dirname, '../node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntime.swift');
if (fs.existsSync(jsRuntimePath)) {
  let content = fs.readFileSync(jsRuntimePath, 'utf8');

  // Fix 1: getter
  if (content.includes('nonisolated(unsafe) let resultPtr = resultPtr')) {
    content = content.replace(
      /let propertyName = String\(cString: propertyName\)\s+nonisolated\(unsafe\) let resultPtr = resultPtr\s+return withGuaranteedContext\(context\) { \(context: HostObjectContext, runtime\) in\s+return JavaScriptActor\.assumeIsolated {/m,
      `let propertyName = String(cString: propertyName)
      let resultPtrBits = Int(bitPattern: resultPtr)

      return withGuaranteedContext(context) { (context: HostObjectContext, runtime) in
        return JavaScriptActor.assumeIsolated {
          guard let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }`
    );
  } else if (content.includes('let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits)!')) {
    content = content.replace(
      /let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>\(bitPattern: resultPtrBits\)!/g,
      'guard let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }'
    );
  }

  // Fix 2 & 3: createFunctionClosure overloads (handling both pristine and partially patched)
  if (content.includes('nonisolated(unsafe) let thisPtr = thisPtr')) {
    content = content.replace(
      /nonisolated\(unsafe\) let thisPtr = thisPtr\s+nonisolated\(unsafe\) let argumentsPtr = argumentsPtr\s+nonisolated\(unsafe\) let resultPtr = resultPtr\s+\/\/ See `withGuaranteedContext`[^\n]*\s+\/\/[^\n]*\s+return withGuaranteedContext\(context\) { \(context: HostFunctionContext, runtime\) in\s+return JavaScriptActor\.assumeIsolated {/m,
      `let thisPtrBits = Int(bitPattern: thisPtr)
    let argumentsPtrBits = Int(bitPattern: argumentsPtr)
    let resultPtrBits = Int(bitPattern: resultPtr)

    return withGuaranteedContext(context) { (context: HostFunctionContext, runtime) in
      return JavaScriptActor.assumeIsolated {
        guard let thisPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: thisPtrBits),
              let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }
        let argumentsPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: argumentsPtrBits)`
    );

    content = content.replace(
      /nonisolated\(unsafe\) let thisPtr = thisPtr\s+nonisolated\(unsafe\) let argumentsPtr = argumentsPtr\s+nonisolated\(unsafe\) let resultPtr = resultPtr\s+\/\/ See `withGuaranteedContext`[^\n]*\s+\/\/[^\n]*\s+return withGuaranteedContext\(context\) { \(context: UnownedThisHostFunctionContext, runtime\) in\s+return JavaScriptActor\.assumeIsolated {/m,
      `let thisPtrBits = Int(bitPattern: thisPtr)
    let argumentsPtrBits = Int(bitPattern: argumentsPtr)
    let resultPtrBits = Int(bitPattern: resultPtr)

    return withGuaranteedContext(context) { (context: UnownedThisHostFunctionContext, runtime) in
      return JavaScriptActor.assumeIsolated {
        guard let thisPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: thisPtrBits),
              let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }
        let argumentsPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: argumentsPtrBits)`
    );
  }

  // Clean up any remaining force-unwraps on thisPtr, argumentsPtr, resultPtr
  content = content.replace(
    /let thisPtr = UnsafePointer<facebook\.jsi\.Value>\(bitPattern: thisPtrBits\)!\s+let argumentsPtr = UnsafePointer<facebook\.jsi\.Value>\(bitPattern: argumentsPtrBits\)\s+guard let resultPtr = UnsafeMutablePointer<facebook\.jsi\.Value>\(bitPattern: resultPtrBits\) else \{ return false \}/g,
    `guard let thisPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: thisPtrBits),
              let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }
        let argumentsPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: argumentsPtrBits)`
  );
  content = content.replace(
    /let thisPtr = UnsafePointer<facebook\.jsi\.Value>\(bitPattern: thisPtrBits\)!\s+let argumentsPtr = UnsafePointer<facebook\.jsi\.Value>\(bitPattern: argumentsPtrBits\)!\s+let resultPtr = UnsafeMutablePointer<facebook\.jsi\.Value>\(bitPattern: resultPtrBits\)!/g,
    `guard let thisPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: thisPtrBits),
              let resultPtr = UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: resultPtrBits) else { return false }
        let argumentsPtr = UnsafePointer<facebook.jsi.Value>(bitPattern: argumentsPtrBits)`
  );

  fs.writeFileSync(jsRuntimePath, content, 'utf8');
  console.log('[patch-expo-jsi] Successfully patched JavaScriptRuntime.swift');
} else {
  console.log('[patch-expo-jsi] JavaScriptRuntime.swift not found, skipping.');
}

console.log('[patch-expo-jsi] Finished patching.');
