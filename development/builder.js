const fs = require("fs");
const AdmZip = require("adm-zip");
const pathUtil = require("path");
const ExtendedJSON = require("@turbowarp/json");
const compatibilityAliases = require("./compatibility-aliases");
const parseMetadata = require("./parse-extension-metadata");
const { mkdirp, recursiveReadDirectory } = require("./fs-utils");

/**
 * @typedef {'development'|'production'|'desktop'} Mode
 */

/**
 * @typedef TranslatableString
 * @property {string} string The English version of the string
 * @property {string} developer_comment Helper text to help translators
 */

/**
 * @param {Record<string, Record<string, string>>} allTranslations
 * @param {string} idPrefix
 * @returns {Record<string, Record<string, string>>|null}
 */
const filterTranslationsByPrefix = (allTranslations, idPrefix) => {
  console.log("filterTranslationsByPrefix called with idPrefix:", idPrefix);
  let translationsEmpty = true;
  const filteredTranslations = {};

  for (const [locale, strings] of Object.entries(allTranslations)) {
    let localeEmpty = true;
    const filteredStrings = {};

    for (const [id, string] of Object.entries(strings)) {
      if (id.startsWith(idPrefix)) {
        filteredStrings[id.substring(idPrefix.length)] = string;
        localeEmpty = false;
      }
    }

    if (!localeEmpty) {
      filteredTranslations[locale] = filteredStrings;
      translationsEmpty = false;
    }
  }

  console.log("filterTranslationsByPrefix result:", filteredTranslations);
  return translationsEmpty ? null : filteredTranslations;
};

/**
 * @param {Record<string, Record<string, string>>} allTranslations
 * @param {string} idFilter
 * @returns {Record<string, string>}
 */
const filterTranslationsByID = (allTranslations, idFilter) => {
  console.log("filterTranslationsByID called with idFilter:", idFilter);
  let stringsEmpty = true;
  const result = {};

  for (const [locale, strings] of Object.entries(allTranslations)) {
    const translated = strings[idFilter];
    if (translated) {
      result[locale] = translated;
      stringsEmpty = false;
    }
  }

  console.log("filterTranslationsByID result:", result);
  return stringsEmpty ? null : result;
};

/**
 * @param {string} oldCode
 * @param {string} insertCode
 */
const insertAfterCommentsBeforeCode = (oldCode, insertCode) => {
  console.log(
    "insertAfterCommentsBeforeCode called with insertCode:",
    insertCode
  );
  let index = 0;
  while (true) {
    if (oldCode.substring(index, index + 2) === "//") {
      // Line comment
      const end = oldCode.indexOf("\n", index);
      if (end === -1) {
        // This file is only line comments
        index = oldCode.length;
        break;
      }
      index = end;
    } else if (oldCode.substring(index, index + 2) === "/*") {
      // Block comment
      const end = oldCode.indexOf("*/", index);
      if (end === -1) {
        throw new Error("Block comment never ends");
      }
      index = end + 2;
    } else if (/\s/.test(oldCode.charAt(index))) {
      // Whitespace
      index++;
    } else {
      break;
    }
  }

  const before = oldCode.substring(0, index);
  const after = oldCode.substring(index);
  const result = before + insertCode + after;
  console.log("insertAfterCommentsBeforeCode result:", result);
  return result;
};

class BuildFile {
  constructor(source) {
    this.sourcePath = source;
  }

  getType() {
    console.log("getType called");
    const result = pathUtil.extname(this.sourcePath);
    console.log("getType result:", result);
    return result;
  }

  getLastModified() {
    console.log("getLastModified called");
    const result = fs.statSync(this.sourcePath).mtimeMs;
    console.log("getLastModified result:", result);
    return result;
  }

  read() {
    console.log("read called");
    const result = fs.readFileSync(this.sourcePath);
    console.log("read result:", result);
    return result;
  }

  validate() {
    console.log("validate called");
    // no-op by default
  }

  /**
   * @returns {Record<string, Record<string, TranslatableString>>|null}
   */
  getStrings() {
    console.log("getStrings called");
    // no-op by default, to be overridden
    return null;
  }
}

class ExtensionFile extends BuildFile {
  /**
   * @param {string} absolutePath Full path to the .js file, eg. /home/.../extensions/fetch.js
   * @param {string} slug Just the extension ID from the path, eg. fetch
   * @param {boolean} featured true if the extension is the homepage
   * @param {Record<string, Record<string, string>>} allTranslations All extension runtime translations
   * @param {Mode} mode
   */
  constructor(absolutePath, slug, featured, allTranslations, mode) {
    super(absolutePath);
    /** @type {string} */
    this.slug = slug;
    /** @type {boolean} */
    this.featured = featured;
    /** @type {Record<string, Record<string, string>>} */
    this.allTranslations = allTranslations;
    /** @type {Mode} */
    this.mode = mode;
    console.log(
      "ExtensionFile constructor called with slug:",
      slug,
      "featured:",
      featured,
      "mode:",
      mode
    );
  }
  read() {
    console.log("read called");
    const data = fs.readFileSync(this.sourcePath, "utf-8");
    console.log("File read successfully:", this.sourcePath);

    if (this.mode !== "development") {
      console.log("Mode is not development, filtering translations");
      const translations = filterTranslationsByPrefix(
        this.allTranslations,
        `${this.slug}@`
      );
      if (translations !== null) {
        console.log("Translations found, inserting localization code");
        return insertAfterCommentsBeforeCode(
          data,
          `/* generated l10n code */Scratch.translate.setup(${JSON.stringify(
            translations
          )});/* end generated l10n code */`
        );
      }
    }

    return data;
  }

  getMetadata() {
    console.log("getMetadata called");
    const data = fs.readFileSync(this.sourcePath, "utf-8");
    console.log("File read successfully for metadata:", this.sourcePath);
    const metadata = parseMetadata(data);
    console.log("Metadata parsed successfully:", metadata);
    return metadata;
  }

  validate() {
    console.log("validate called");
    if (!this.featured) {
      console.log("Not featured, skipping validation");
      return;
    }

    const metadata = this.getMetadata();

    if (!metadata.id) {
      console.error("Validation error: Missing // ID:");
      throw new Error("Missing // ID:");
    }

    if (!metadata.name) {
      console.error("Validation error: Missing // Name:");
      throw new Error("Missing // Name:");
    }

    if (!metadata.description) {
      console.error("Validation error: Missing // Description:");
      throw new Error("Missing // Description:");
    }

    const PUNCTUATION = [".", "!", "?"];
    if (
      !PUNCTUATION.some((punctuation) =>
        metadata.description.endsWith(punctuation)
      )
    ) {
      console.error(
        "Validation error: Description is missing punctuation:",
        metadata.description
      );
      throw new Error(
        `Description is missing punctuation: ${metadata.description}`
      );
    }

    if (!metadata.license) {
      console.error("Validation error: Missing // License:");
      throw new Error(
        "Missing // License: -- We recommend using // License: MPL-2.0"
      );
    }

    const spdxParser = require("spdx-expression-parse");
    try {
      // Don't care about the result -- just see if it parses.
      spdxParser(metadata.license);
    } catch (e) {
      console.error(
        "Validation error: Invalid SPDX license:",
        metadata.license
      );
      throw new Error(
        `${metadata.license} is not a valid SPDX license. Did you typo it? It is case sensitive. We recommend using // License: MPL-2.0`
      );
    }

    for (const person of [...metadata.by, ...metadata.original]) {
      if (!person.name) {
        console.error("Validation error: Person is missing name");
        throw new Error("Person is missing name");
      }
      if (
        person.link &&
        !person.link.startsWith("https://scratch.mit.edu/users/")
      ) {
        console.error(
          "Validation error: Invalid link for person:",
          person.name
        );
        throw new Error(
          `Link for ${person.name} does not point to a Scratch user`
        );
      }
    }
  }

  getStrings() {
    console.log("getStrings called");
    if (!this.featured) {
      console.log("Not featured, returning null");
      return null;
    }

    const metadata = this.getMetadata();
    console.log("Metadata retrieved:", metadata);
    const slug = this.slug;
    console.log("Slug:", slug);

    const getMetadataDescription = (part) => {
      let result = `${part} of the '${metadata.name}' extension in the extension gallery.`;
      if (metadata.context) {
        result += ` ${metadata.context}`;
      }
      return result;
    };

    const metadataStrings = {
      [`${slug}@name`]: {
        string: metadata.name,
        developer_comment: getMetadataDescription("Name"),
      },
      [`${slug}@description`]: {
        string: metadata.description,
        developer_comment: getMetadataDescription("Description"),
      },
    };
    console.log("Metadata strings:", metadataStrings);

    const parseTranslations = require("./parse-extension-translations");
    const jsCode = fs.readFileSync(this.sourcePath, "utf-8");
    console.log("JavaScript code read from file:", jsCode);
    const unprefixedRuntimeStrings = parseTranslations(jsCode);
    console.log("Unprefixed runtime strings:", unprefixedRuntimeStrings);

    const runtimeStrings = Object.fromEntries(
      Object.entries(unprefixedRuntimeStrings).map(([key, value]) => [
        `${slug}@${key}`,
        value,
      ])
    );
    console.log("Runtime strings:", runtimeStrings);

    const result = {
      "extension-metadata": metadataStrings,
      "extension-runtime": runtimeStrings,
    };
    console.log("getStrings result:", result);

    return result;
  }
}

class HomepageFile extends BuildFile {
  constructor(
    extensionFiles,
    extensionImages,
    featuredSlugs,
    withDocs,
    samples,
    mode
  ) {
    console.log("Constructor called with parameters:", {
      extensionFiles,
      extensionImages,
      featuredSlugs,
      withDocs,
      samples,
      mode,
    });
    super(pathUtil.join(__dirname, "homepage-template.ejs"));

    /** @type {Record<string, ExtensionFile>} */
    this.extensionFiles = extensionFiles;

    /** @type {Record<string, string>} */
    this.extensionImages = extensionImages;

    /** @type {string[]} */
    this.featuredSlugs = featuredSlugs;

    /** @type {Map<string, SampleFile[]>} */
    this.withDocs = withDocs;

    /** @type {SampleFile[]} */
    this.samples = samples;

    /** @type {Mode} */
    this.mode = mode;

    this.host =
      mode === "development"
        ? "http://localhost:8000/"
        : "https://scsupercraft.github.io/extensions/";

    console.log("Constructor initialized with host:", this.host);
  }

  getType() {
    console.log("getType called");
    return ".html";
  }

  getFullExtensionURL(extensionSlug) {
    const url = `${this.host}${extensionSlug}.js`;
    console.log(
      "getFullExtensionURL called with extensionSlug:",
      extensionSlug,
      "resulting URL:",
      url
    );
    return url;
  }

  getDocumentationURL(extensionSlug) {
    const url = `${this.host}${extensionSlug}`;
    console.log(
      "getDocumentationURL called with extensionSlug:",
      extensionSlug,
      "resulting URL:",
      url
    );
    return url;
  }

  getRunExtensionURL(extensionSlug) {
    const url = `https://turbowarp.org/editor?extension=${this.getFullExtensionURL(extensionSlug)}`;
    console.log(
      "getRunExtensionURL called with extensionSlug:",
      extensionSlug,
      "resulting URL:",
      url
    );
    return url;
  }

  /**
   * @param {SampleFile} sampleFile
   * @returns {string}
   */
  getRunSampleURL(sampleFile) {
    console.log("getRunSampleURL called with sampleFile:", sampleFile);
    const path = encodeURIComponent(`samples/${sampleFile.getSlug()}`);
    const url = `https://turbowarp.org/editor?project_url=${this.host}${path}`;
    console.log("Generated run sample URL:", url);
    return url;
  }

  read() {
    console.log("read called");
    const renderTemplate = require("./render-template");

    const mostRecentExtensions = Object.entries(this.extensionFiles)
      .sort((a, b) => b[1].getLastModified() - a[1].getLastModified())
      .slice(0, 5)
      .map((i) => i[0]);
    console.log("Most recent extensions:", mostRecentExtensions);

    const extensionMetadata = Object.fromEntries(
      this.featuredSlugs.map((slug) => [
        slug,
        {
          ...this.extensionFiles[slug].getMetadata(),
          hasDocumentation: this.withDocs.has(slug),
          samples: this.samples.get(slug) || [],
        },
      ])
    );
    console.log("Extension metadata:", extensionMetadata);

    const result = renderTemplate(this.sourcePath, {
      mode: this.mode,
      mostRecentExtensions,
      extensionImages: this.extensionImages,
      extensionMetadata,
      getFullExtensionURL: this.getFullExtensionURL.bind(this),
      getRunExtensionURL: this.getRunExtensionURL.bind(this),
      getDocumentationURL: this.getDocumentationURL.bind(this),
      getRunSampleURL: this.getRunSampleURL.bind(this),
    });
    console.log("Rendered template result:", result);

    return result;
  }
}

class JSONMetadataFile extends BuildFile {
  constructor(
    extensionFiles,
    extensionImages,
    featuredSlugs,
    withDocs,
    samples,
    allTranslations
  ) {
    console.log("Constructor called with parameters:", {
      extensionFiles,
      extensionImages,
      featuredSlugs,
      withDocs,
      samples,
      allTranslations,
    });
    super(null);

    /** @type {Record<string, ExtensionFile>} */
    this.extensionFiles = extensionFiles;

    /** @type {Record<string, string>} */
    this.extensionImages = extensionImages;

    /** @type {string[]} */
    this.featuredSlugs = featuredSlugs;

    /** @type {Set<string>} */
    this.withDocs = withDocs;

    /** @type {Map<string, SampleFile[]>} */
    this.samples = samples;

    /** @type {Record<string, Record<string, string>>} */
    this.allTranslations = allTranslations;

    console.log("Constructor initialized");
  }

  getType() {
    console.log("getType called");
    return ".json";
  }

  read() {
    console.log("read called");
    const extensions = [];
    for (const extensionSlug of this.featuredSlugs) {
      console.log("Processing extensionSlug:", extensionSlug);
      const extension = {};
      const file = this.extensionFiles[extensionSlug];
      const metadata = file.getMetadata();
      const image = this.extensionImages[extensionSlug];

      extension.slug = extensionSlug;
      extension.id = metadata.id;

      // English fields
      extension.name = metadata.name;
      extension.description = metadata.description;

      // For other languages, translations go here.
      // This system is a bit silly to avoid backwards-incompatible JSON changes.
      const nameTranslations = filterTranslationsByID(
        this.allTranslations,
        `${extensionSlug}@name`
      );
      if (nameTranslations) {
        extension.nameTranslations = nameTranslations;
      }
      const descriptionTranslations = filterTranslationsByID(
        this.allTranslations,
        `${extensionSlug}@description`
      );
      if (descriptionTranslations) {
        extension.descriptionTranslations = descriptionTranslations;
      }

      if (image) {
        extension.image = image;
      }
      if (metadata.by.length) {
        extension.by = metadata.by;
      }
      if (metadata.original.length) {
        extension.original = metadata.original;
      }
      if (this.withDocs.has(extensionSlug)) {
        extension.docs = true;
      }
      const samples = this.samples.get(extensionSlug);
      if (samples) {
        extension.samples = samples.map((i) => i.getTitle());
      }

      extensions.push(extension);
      console.log("Extension processed:", extension);
    }

    const data = {
      extensions,
    };
    const jsonData = JSON.stringify(data);
    console.log("JSON data generated:", jsonData);
    return jsonData;
  }
}

class ImageFile extends BuildFile {
  validate() {
    console.log("ImageFile validate called");
    const sizeOfImage = require("image-size");
    const contents = this.read();
    console.log("Image contents read");
    const { width, height } = sizeOfImage(contents);
    console.log("Image dimensions:", { width, height });
    const aspectRatio = width / height;
    console.log("Aspect ratio calculated:", aspectRatio);
    if (aspectRatio !== 2) {
      console.error(
        `Aspect ratio must be exactly 2, but found ${aspectRatio.toFixed(
          4
        )} (${width}x${height})`
      );
      throw new Error(
        `Aspect ratio must be exactly 2, but found ${aspectRatio.toFixed(
          4
        )} (${width}x${height})`
      );
    }
  }
}

class SVGFile extends ImageFile {
  validate() {
    console.log("SVGFile validate called");
    const contents = this.read();
    console.log("SVG contents read");
    if (contents.includes("<text")) {
      console.error("SVG contains <text> elements");
      throw new Error(
        "SVG must not contain <text> elements -- please convert the text to a path. This ensures it will display correctly on all devices."
      );
    }

    super.validate();
  }
}

const IMAGE_FORMATS = new Map();
IMAGE_FORMATS.set(".png", ImageFile);
IMAGE_FORMATS.set(".jpg", ImageFile);
IMAGE_FORMATS.set(".svg", SVGFile);

class SitemapFile extends BuildFile {
  constructor(build) {
    console.log("SitemapFile constructor called with build:", build);
    super(null);
    this.build = build;
    console.log("SitemapFile initialized");
  }

  getType() {
    console.log("getType called");
    return ".xml";
  }

  read() {
    console.log("SitemapFile read called");
    let xml = "";
    xml += '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    const urls = Object.keys(this.build.files)
      .filter((file) => file.endsWith(".html"))
      .map((file) => file.replace("index.html", "").replace(".html", ""))
      .sort((a, b) => {
        if (a.length < b.length) return -1;
        if (a.length > b.length) return 1;
        return a - b;
      })
      .map((path) => `https://extensions.turbowarp.org${path}`)
      .map((absoluteURL) => `<url><loc>${absoluteURL}</loc></url>`)
      .join("\n");

    xml += urls;
    xml += "</urlset>\n";
    console.log("Generated XML:", xml);
    return xml;
  }
}

class DocsFile extends BuildFile {
  constructor(absolutePath, extensionSlug) {
    console.log("DocsFile constructor called with:", {
      absolutePath,
      extensionSlug,
    });
    super(absolutePath);
    this.extensionSlug = extensionSlug;
    console.log("DocsFile initialized with extensionSlug:", this.extensionSlug);
  }

  read() {
    console.log("DocsFile read called");
    const renderDocs = require("./render-docs");
    const markdown = super.read().toString("utf-8");
    console.log("Markdown content read:", markdown);
    const result = renderDocs(markdown, this.extensionSlug);
    console.log("Rendered docs:", result);
    return result;
  }

  getType() {
    console.log("DocsFile getType called");
    return ".html";
  }
}

class SampleFile extends BuildFile {
  getSlug() {
    console.log("SampleFile getSlug called");
    const slug = pathUtil.basename(this.sourcePath);
    console.log("Slug obtained:", slug);
    return slug;
  }

  getTitle() {
    console.log("SampleFile getTitle called");
    const title = this.getSlug().replace(".sb3", "").replace(".pmp", "");
    console.log("Title obtained:", title);
    return title;
  }

  /** @returns {string[]} list of full URLs */
  getExtensionURLs() {
    console.log("SampleFile getExtensionURLs called");
    const zip = new AdmZip(this.sourcePath);
    const entry = zip.getEntry("project.json");
    if (!entry) {
      console.error("project.json missing in the zip file");
      throw new Error("project.json missing");
    }
    const data = JSON.parse(entry.getData().toString("utf-8"));
    const urls = data.extensionURLs ? Object.values(data.extensionURLs) : [];
    console.log("Extension URLs obtained:", urls);
    return urls;
  }

  validate() {
    console.log("SampleFile validate called");
    const urls = this.getExtensionURLs();
    console.log("URLs to validate:", urls);

    if (urls.length === 0) {
      console.error("Validation error: Has no extensions");
      throw new Error("Has no extensions");
    }

    for (const url of urls) {
      if (
        (!url.startsWith("https://scsupercraft.github.io/extensions/") &&
          !url.startsWith("https://extensions.turbowarp.org/extensions/")) ||
        !url.endsWith(".js")
      ) {
        console.error(
          "Validation error: Invalid extension URL for sample:",
          url
        );
        throw new Error(`Invalid extension URL for sample: ${url}`);
      }
    }
  }
}

class Build {
  constructor() {
    console.log("Build constructor called");
    /** @type {Record<string, BuildFile>} */
    this.files = {};
    console.log("Build initialized with empty files object");
  }

  getFile(path) {
    console.log("getFile called with path:", path);
    const file =
      this.files[path] ||
      this.files[`${path}.html`] ||
      this.files[`${path}index.html`] ||
      null;
    console.log("getFile result:", file);
    return file;
  }

  export(root) {
    console.log("export called with root:", root);
    mkdirp(root);
    console.log("Directory created or already exists:", root);

    for (const [relativePath, file] of Object.entries(this.files)) {
      console.log("Exporting file:", relativePath);
      const directoryName = pathUtil.dirname(relativePath);
      fs.mkdirSync(pathUtil.join(root, directoryName), { recursive: true });
      console.log("Directory created for file:", directoryName);
      fs.writeFileSync(pathUtil.join(root, relativePath), file.read());
      console.log("File written:", relativePath);
    }
  }

  /**
   * @returns {Record<string, Record<string, TranslatableString>>}
   */
  generateL10N() {
    console.log("generateL10N called");
    const allStrings = {};

    for (const [filePath, file] of Object.entries(this.files)) {
      console.log("Processing file for L10N:", filePath);
      let fileStrings;
      try {
        fileStrings = file.getStrings();
        console.log("Strings obtained from file:", fileStrings);
      } catch (error) {
        console.error("Error getting translations from file:", filePath, error);
        throw new Error(
          `Error getting translations from ${filePath}: ${error}, see above`
        );
      }
      if (!fileStrings) {
        console.log("No strings found for file:", filePath);
        continue;
      }

      for (const [group, strings] of Object.entries(fileStrings)) {
        if (!allStrings[group]) {
          allStrings[group] = {};
        }

        for (const [key, value] of Object.entries(strings)) {
          if (allStrings[key]) {
            console.error("L10N collision detected:", key, "in group", group);
            throw new Error(
              `L10N collision: multiple instances of ${key} in group ${group}`
            );
          }
          allStrings[group][key] = value;
        }
      }
    }

    console.log("Generated L10N strings:", allStrings);
    return allStrings;
  }

  /**
   * @param {string} root
   */
  exportL10N(root) {
    console.log("exportL10N called with root:", root);
    mkdirp(root);
    console.log("Directory created or already exists for L10N export:", root);

    const groups = this.generateL10N();
    for (const [name, strings] of Object.entries(groups)) {
      const filename = pathUtil.join(root, `exported-${name}.json`);
      fs.writeFileSync(filename, JSON.stringify(strings, null, 2));
      console.log("L10N file written:", filename);
    }
  }
}

class Builder {
  /**
   * @param {Mode} mode
   */
  constructor(mode) {
    console.log("Constructor called with mode:", mode);

    if (process.argv.includes("--production")) {
      this.mode = "production";
      console.log("Mode set to production");
    } else if (process.argv.includes("--development")) {
      this.mode = "development";
      console.log("Mode set to development");
    } else if (process.argv.includes("--desktop")) {
      this.mode = "desktop";
      console.log("Mode set to desktop");
    } else {
      /** @type {Mode} */
      this.mode = mode;
      console.log("Mode set to provided mode:", mode);
    }

    this.extensionsRoot = pathUtil.join(__dirname, "../extensions");
    this.websiteRoot = pathUtil.join(__dirname, "../website");
    this.imagesRoot = pathUtil.join(__dirname, "../images");
    this.docsRoot = pathUtil.join(__dirname, "../docs");
    this.samplesRoot = pathUtil.join(__dirname, "../samples");
    this.translationsRoot = pathUtil.join(__dirname, "../translations");

    console.log("Paths initialized:", {
      extensionsRoot: this.extensionsRoot,
      websiteRoot: this.websiteRoot,
      imagesRoot: this.imagesRoot,
      docsRoot: this.docsRoot,
      samplesRoot: this.samplesRoot,
      translationsRoot: this.translationsRoot,
    });
  }

  build() {
    console.log("build method called");
    const build = new Build(this.mode);
    console.log("Build instance created with mode:", this.mode);

    const featuredExtensionSlugs = ExtendedJSON.parse(
      fs.readFileSync(
        pathUtil.join(this.extensionsRoot, "extensions.json"),
        "utf-8"
      )
    );
    console.log("Featured extension slugs loaded:", featuredExtensionSlugs);

    /**
     * Look up by [group][locale][id]
     * @type {Record<string, Record<string, Record<string, string>>>}
     */
    const translations = {};
    for (const [filename, absolutePath] of recursiveReadDirectory(
      this.translationsRoot
    )) {
      if (!filename.endsWith(".json")) {
        continue;
      }
      const group = filename.split(".")[0];
      const data = JSON.parse(fs.readFileSync(absolutePath, "utf-8"));
      translations[group] = data;
      console.log(`Translations loaded for group ${group}:`, data);
    }

    /** @type {Record<string, ExtensionFile>} */
    const extensionFiles = {};
    for (const [filename, absolutePath] of recursiveReadDirectory(
      this.extensionsRoot
    )) {
      if (!filename.endsWith(".js")) {
        continue;
      }
      const extensionSlug = filename.split(".")[0];
      const featured = featuredExtensionSlugs.includes(extensionSlug);
      const file = new ExtensionFile(
        absolutePath,
        extensionSlug,
        featured,
        translations["extension-runtime"],
        this.mode
      );
      extensionFiles[extensionSlug] = file;
      build.files[`/${filename}`] = file;
      console.log(`Extension file added: ${filename}`, file);
    }

    /** @type {Record<string, ImageFile>} */
    const extensionImages = {};
    for (const [filename, absolutePath] of recursiveReadDirectory(
      this.imagesRoot
    )) {
      const extension = pathUtil.extname(filename);
      const ImageFileClass = IMAGE_FORMATS.get(extension);
      if (!ImageFileClass) {
        continue;
      }
      const extensionSlug = filename.split(".")[0];
      if (extensionSlug !== "unknown") {
        extensionImages[extensionSlug] = `images/${filename}`;
      }
      build.files[`/images/${filename}`] = new ImageFileClass(absolutePath);
      console.log(`Image file added: ${filename}`, absolutePath);
    }

    /** @type {Set<string>} */
    const extensionsWithDocs = new Set();

    /** @type {Map<string, SampleFile[]>} */
    const samples = new Map();
    for (const [filename, absolutePath] of recursiveReadDirectory(
      this.samplesRoot
    )) {
      if (!filename.endsWith(".sb3") && !filename.endsWith(".pmp")) {
        continue;
      }

      const file = new SampleFile(absolutePath);
      for (const url of file.getExtensionURLs()) {
        const slug = new URL(url).pathname.substring(1).replace(".js", "");
        if (samples.has(slug)) {
          samples.get(slug).push(file);
        } else {
          samples.set(slug, [file]);
        }
      }
      build.files[`/samples/${filename}`] = file;
      console.log(`Sample file added: ${filename}`, file);
    }

    for (const [filename, absolutePath] of recursiveReadDirectory(
      this.websiteRoot
    )) {
      build.files[`/${filename}`] = new BuildFile(absolutePath);
      console.log(`Website file added: ${filename}`, absolutePath);
    }

    if (this.mode !== "desktop") {
      for (const [filename, absolutePath] of recursiveReadDirectory(
        this.docsRoot
      )) {
        if (!filename.endsWith(".md")) {
          continue;
        }
        const extensionSlug = filename.split(".")[0];
        const file = new DocsFile(absolutePath, extensionSlug);
        extensionsWithDocs.add(extensionSlug);
        build.files[`/${extensionSlug}.html`] = file;
        console.log(`Docs file added: ${filename}`, file);
      }

      const scratchblocksPath = pathUtil.join(
        __dirname,
        "../node_modules/@turbowarp/scratchblocks/build/scratchblocks.min.js"
      );
      build.files["/docs-internal/scratchblocks.js"] = new BuildFile(
        scratchblocksPath
      );
      console.log("Scratchblocks file added:", scratchblocksPath);

      build.files["/index.html"] = new HomepageFile(
        extensionFiles,
        extensionImages,
        featuredExtensionSlugs,
        extensionsWithDocs,
        samples,
        this.mode
      );
      console.log("Homepage file added");

      build.files["/sitemap.xml"] = new SitemapFile(build);
      console.log("Sitemap file added");
    }

    console.log("Adding JSONMetadataFile to build.files");
    build.files["/generated-metadata/extensions-v0.json"] =
      new JSONMetadataFile(
        extensionFiles,
        extensionImages,
        featuredExtensionSlugs,
        extensionsWithDocs,
        samples,
        translations["extension-metadata"]
      );
    console.log("JSONMetadataFile added to build.files");

    console.log("Processing compatibility aliases");
    for (const [oldPath, newPath] of Object.entries(compatibilityAliases)) {
      build.files[oldPath] = build.files[newPath];
      console.log(`Alias created: ${oldPath} -> ${newPath}`);
    }

    console.log("Build process completed");
    return build;
  }

  tryBuild(...args) {
    const start = new Date();
    console.log(`[${start.toLocaleTimeString()}] Building...`);

    try {
      const build = this.build(...args);
      const time = Date.now() - start.getTime();
      console.log(`Build completed in ${time}ms`);
      return build;
    } catch (error) {
      console.log("Build error");
      console.error(error);
    }

    return null;
  }

  startWatcher(callback) {
    console.log("startWatcher called");
    // Load chokidar lazily.
    const chokidar = require("chokidar");
    console.log("Chokidar loaded");

    callback(this.tryBuild());
    console.log("Initial build triggered");

    chokidar
      .watch(
        [
          `${this.extensionsRoot}/**/*`,
          `${this.imagesRoot}/**/*`,
          `${this.websiteRoot}/**/*`,
          `${this.docsRoot}/**/*`,
          `${this.samplesRoot}/**/*`,
          `${this.translationsRoot}/**/*`,
        ],
        {
          ignoreInitial: true,
        }
      )
      .on("all", (event, path) => {
        console.log(`File change detected: ${event} at ${path}`);
        callback(this.tryBuild());
      });
  }

  validate() {
    console.log("validate called");
    const errors = [];
    const build = this.build();
    console.log("Build generated for validation");

    for (const [fileName, file] of Object.entries(build.files)) {
      try {
        file.validate();
        console.log(`File validated: ${fileName}`);
      } catch (e) {
        console.error(`Validation error in file: ${fileName}`, e);
        errors.push({
          fileName,
          error: e,
        });
      }
    }

    if (errors.length > 0) {
      console.log("Validation completed with errors");
    } else {
      console.log("Validation completed successfully");
    }

    return errors;
  }
}

module.exports = Builder;
