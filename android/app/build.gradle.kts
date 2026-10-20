import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The browse screens, phone-remote page and shared JS come from the desktop project, so both apps
// always run the same interface. This copies them into the APK's assets and adds the Android glue.
abstract class CopyWebAssets : DefaultTask() {
    @get:InputDirectory abstract val rendererDir: DirectoryProperty
    @get:InputDirectory abstract val remoteDir: DirectoryProperty
    @get:InputFile abstract val coreJs: RegularFileProperty
    @get:InputDirectory abstract val androidWebDir: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty
    @get:Inject abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        val out = outputDir.get().asFile
        fs.sync {
            into(out)
            from(rendererDir.get().asFile) {
                into("web/renderer")
                filesMatching("index.html") {
                    filter { line ->
                        when {
                            // Lay the page out 1600 px wide and let the WebView scale it to the TV.
                            line.contains("name=\"viewport\"") -> "<meta name=\"viewport\" content=\"width=1600, user-scalable=no\">"
                            line.contains("src=\"app.js\"") ->
                                "<script src=\"../lib/media-core.js\"></script>\n" +
                                "<script src=\"../android/qrcode.js\"></script>\n" +
                                "<script src=\"../android/android-api.js\"></script>\n" + line
                            else -> line
                        }
                    }
                }
            }
            from(remoteDir.get().asFile) { into("web/remote") }
            from(coreJs.get().asFile) { into("web/lib") }
            from(androidWebDir.get().asFile) { into("web/android") }
        }
    }
}

val buildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

android {
    namespace = "com.screenroom.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.screenroom.tv"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "0.5.$buildNumber"
    }

    // A fixed key so each new build installs over the last one (keeping your library and progress).
    signingConfigs {
        create("screenroom") {
            storeFile = file("screenroom-release.jks")
            storePassword = "screenroom"
            keyAlias = "screenroom"
            keyPassword = "screenroom"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("screenroom")
        }
        debug {
            signingConfig = signingConfigs.getByName("screenroom")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

val copyWebAssets = tasks.register<CopyWebAssets>("copyWebAssets") {
    rendererDir.set(file("../../renderer"))
    remoteDir.set(file("../../remote"))
    coreJs.set(file("../../lib/media-core.js"))
    androidWebDir.set(file("src/main/web"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyWebAssets, CopyWebAssets::outputDir)
    }
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.annotation:annotation:1.8.2")
    implementation("androidx.annotation:annotation-experimental:1.4.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
}
