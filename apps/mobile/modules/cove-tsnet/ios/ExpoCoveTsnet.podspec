Pod::Spec.new do |s|
  s.name = 'ExpoCoveTsnet'
  s.version = '0.0.0'
  s.summary = 'Cove app-owned tsnet transport'
  s.description = 'Native ownership and bounded HTTP/WebSocket ports for Cove.'
  s.license = { :type => 'MIT' }
  s.author = 'GhostFlying'
  s.homepage = 'https://github.com/GhostFlying/cove'
  s.source = { :git => 'https://github.com/GhostFlying/cove.git' }
  s.platforms = { :ios => '16.0' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.vendored_frameworks = '../generated/ios/CoveTsnet.xcframework'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
