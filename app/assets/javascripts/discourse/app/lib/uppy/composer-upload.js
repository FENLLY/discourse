import { warn } from "@ember/debug";
import EmberObject from "@ember/object";
import { getOwner, setOwner } from "@ember/owner";
import { run } from "@ember/runloop";
import { service } from "@ember/service";
import Uppy from "@uppy/core";
import DropTarget from "@uppy/drop-target";
import XHRUpload from "@uppy/xhr-upload";
import { cacheShortUploadUrl } from "pretty-text/upload-short-url";
import { updateCsrfToken } from "discourse/lib/ajax";
import ComposerVideoThumbnailUppy from "discourse/lib/composer-video-thumbnail-uppy";
import {
  bindFileInputChangeListener,
  displayErrorForBulkUpload,
  displayErrorForUpload,
  getUploadMarkdown,
  isImage,
  validateUploadedFile,
} from "discourse/lib/uploads";
import UppyS3Multipart from "discourse/lib/uppy/s3-multipart";
import UppyWrapper from "discourse/lib/uppy/wrapper";
import UppyChecksum from "discourse/lib/uppy-checksum-plugin";
import { clipboardHelpers } from "discourse/lib/utilities";
import getURL from "discourse-common/lib/get-url";
import { bind } from "discourse-common/utils/decorators";
import escapeRegExp from "discourse-common/utils/escape-regexp";
import { i18n } from "discourse-i18n";

export default class UppyComposerUpload {
  @service dialog;
  @service session;
  @service siteSettings;
  @service appEvents;
  @service currentUser;
  @service site;
  @service capabilities;
  @service messageBus;
  @service composer;

  uppyWrapper;

  uploadRootPath = "/uploads";
  uppyId = "composer-editor-uppy";
  uploadType = "composer";
  editorInputClass = ".d-editor-input";
  mobileFileUploaderId = "mobile-file-upload";
  fileUploadElementId;
  editorClass = ".d-editor";

  composerEventPrefix;
  composerModel;
  uploadMarkdownResolvers;
  uploadPreProcessors;
  uploadHandlers;

  #inProgressUploads = [];
  #bufferedUploadErrors = [];
  #placeholders = {};
  #consecutiveImages = [];

  #useUploadPlaceholders = true;
  #uploadTargetBound = false;
  #userCancelled = false;

  #fileInputEl;
  #editorEl;

  constructor(
    owner,
    {
      composerEventPrefix,
      composerModel,
      uploadMarkdownResolvers,
      uploadPreProcessors,
      uploadHandlers,
      fileUploadElementId,
    }
  ) {
    setOwner(this, owner);
    this.uppyWrapper = new UppyWrapper(owner);
    this.composerEventPrefix = composerEventPrefix;
    this.composerModel = composerModel;
    this.uploadMarkdownResolvers = uploadMarkdownResolvers;
    this.uploadPreProcessors = uploadPreProcessors;
    this.uploadHandlers = uploadHandlers;
    this.fileUploadElementId = fileUploadElementId;
  }

  @bind
  _cancelUpload(data) {
    if (data) {
      // Single file
      this.uppyWrapper.uppyInstance.removeFile(data.fileId);
    } else {
      // All files
      this.#userCancelled = true;
      this.uppyWrapper.uppyInstance.cancelAll();
    }
  }

  teardown() {
    if (!this.#uploadTargetBound) {
      return;
    }

    this.#fileInputEl?.removeEventListener(
      "change",
      this.fileInputEventListener
    );

    this.#editorEl?.removeEventListener("paste", this._pasteEventListener);

    this.appEvents.off(`${this.composerEventPrefix}:add-files`, this._addFiles);
    this.appEvents.off(
      `${this.composerEventPrefix}:cancel-upload`,
      this._cancelUpload
    );

    this.#reset();

    if (this.uppyWrapper.uppyInstance) {
      this.uppyWrapper.uppyInstance.destroy();
      this.uppyWrapper.uppyInstance = null;
    }

    this.#unbindMobileUploadButton();
    this.#uploadTargetBound = false;
  }

  #abortAndReset() {
    this.appEvents.trigger(`${this.composerEventPrefix}:uploads-aborted`);
    this.#reset();
    return false;
  }

  setup(element) {
    this.#editorEl = element.querySelector(this.editorClass);
    this.#fileInputEl = document.getElementById(this.fileUploadElementId);

    this.appEvents.on(`${this.composerEventPrefix}:add-files`, this._addFiles);
    this.appEvents.on(
      `${this.composerEventPrefix}:cancel-upload`,
      this._cancelUpload
    );

    this.fileInputEventListener = bindFileInputChangeListener(
      this.#fileInputEl,
      this._addFiles
    );
    this.#editorEl.addEventListener("paste", this._pasteEventListener);

    this.uppyWrapper.uppyInstance = new Uppy({
      id: this.uppyId,
      autoProceed: true,

      // need to use upload_type because uppy overrides type with the
      // actual file type
      meta: { upload_type: this.uploadType },

      onBeforeFileAdded: (currentFile) => {
        const validationOpts = {
          user: this.currentUser,
          siteSettings: this.siteSettings,
          isPrivateMessage: this.composerModel.privateMessage,
          allowStaffToUploadAnyFileInPm:
            this.siteSettings.allow_staff_to_upload_any_file_in_pm,
        };

        const isUploading = validateUploadedFile(currentFile, validationOpts);

        this.composer.setProperties({
          uploadProgress: 0,
          isUploading,
          isCancellable: isUploading,
        });

        if (!isUploading) {
          this.appEvents.trigger(`${this.composerEventPrefix}:uploads-aborted`);
        }
        return isUploading;
      },

      onBeforeUpload: (files) => {
        const maxFiles = this.siteSettings.simultaneous_uploads;

        // Look for a matching file upload handler contributed from a plugin.
        // In future we may want to devise a nicer way of doing this.
        // Uppy plugins are out of the question because there is no way to
        // define which uploader plugin handles which file extensions at this time.
        const unhandledFiles = {};
        const handlerBuckets = {};

        for (const [fileId, file] of Object.entries(files)) {
          const matchingHandler = this.#findMatchingUploadHandler(file.name);
          if (matchingHandler) {
            // the function signature will be converted to a string for the
            // object key, so we can send multiple files at once to each handler
            if (handlerBuckets[matchingHandler.method]) {
              handlerBuckets[matchingHandler.method].files.push(file);
            } else {
              handlerBuckets[matchingHandler.method] = {
                fn: matchingHandler.method,
                // file.data is the native File object, which is all the plugins
                // should need, not the uppy wrapper
                files: [file.data],
              };
            }
          } else {
            unhandledFiles[fileId] = { ...files[fileId] };
          }
        }

        // Send the collected array of files to each matching handler,
        // rather than the old jQuery file uploader method of sending
        // a single file at a time through to the handler.
        for (const bucket of Object.values(handlerBuckets)) {
          if (!bucket.fn(bucket.files, this)) {
            return this.#abortAndReset();
          }
        }

        // Limit the number of simultaneous uploads, for files which have
        // _not_ been handled by an upload handler.
        const fileCount = Object.keys(unhandledFiles).length;
        if (maxFiles > 0 && fileCount > maxFiles) {
          this.dialog.alert(
            i18n("post.errors.too_many_dragged_and_dropped_files", {
              count: maxFiles,
            })
          );
          return this.#abortAndReset();
        }

        // uppy uses this new object to track progress of remaining files
        return unhandledFiles;
      },
    });

    if (this.siteSettings.enable_upload_debug_mode) {
      this.uppyWrapper.debug.instrumentUploadTimings(
        this.uppyWrapper.uppyInstance
      );
    }

    if (this.siteSettings.enable_direct_s3_uploads) {
      new UppyS3Multipart(getOwner(this), {
        uploadRootPath: this.uploadRootPath,
        uppyWrapper: this.uppyWrapper,
        errorHandler: this._handleUploadError,
      }).apply(this.uppyWrapper.uppyInstance);
    } else {
      this.#useXHRUploads();
    }

    this.uppyWrapper.uppyInstance.on("file-added", (file) => {
      run(() => {
        if (this.composerModel.privateMessage) {
          file.meta.for_private_message = true;
        }

        if (isImage(file.name)) {
          this.#consecutiveImages.push(file.name);
        }
      });
    });

    this.uppyWrapper.uppyInstance.on("progress", (progress) => {
      run(() => {
        if (this.isDestroying || this.isDestroyed) {
          return;
        }

        this.composer.set("uploadProgress", progress);
      });
    });

    this.uppyWrapper.uppyInstance.on("file-removed", (file, reason) => {
      run(() => {
        // we handle the cancel-all event specifically, so no need
        // to do anything here. this event is also fired when some files
        // are handled by an upload handler
        if (reason === "cancel-all") {
          return;
        }
        this.appEvents.trigger(
          `${this.composerEventPrefix}:upload-cancelled`,
          file.id
        );
        file.meta.cancelled = true;
        this.#removeInProgressUpload(file.id);
        this.#resetUpload(file, { removePlaceholder: true });
        if (this.#inProgressUploads.length === 0) {
          this.#userCancelled = true;
          this.uppyWrapper.uppyInstance.cancelAll();
        }
      });
    });

    this.uppyWrapper.uppyInstance.on("upload-progress", (file, progress) => {
      run(() => {
        if (this.isDestroying || this.isDestroyed) {
          return;
        }
        const upload = this.#inProgressUploads.find(
          (upl) => upl.id === file.id
        );
        if (upload) {
          const percentage = Math.round(
            (progress.bytesUploaded / progress.bytesTotal) * 100
          );
          upload.set("progress", percentage);
        }
      });
    });

    this.uppyWrapper.uppyInstance.on("upload", (uploadId, files) => {
      run(() => {
        this.uppyWrapper.addNeedProcessing(files.length);

        this.composer.setProperties({
          isProcessingUpload: true,
          isCancellable: false,
        });

        files.forEach((file) => {
          // The inProgressUploads is meant to be used to display these uploads
          // in a UI, and Ember will only update the array in the UI if pushObject
          // is used to notify it.
          this.#inProgressUploads.pushObject(
            EmberObject.create({
              fileName: file.name,
              id: file.id,
              progress: 0,
              extension: file.extension,
            })
          );

          const placeholder = this.#uploadPlaceholder(file);
          this.#placeholders[file.id] = {
            uploadPlaceholder: placeholder,
          };

          if (this.#useUploadPlaceholders) {
            this.appEvents.trigger(
              `${this.composerEventPrefix}:insert-text`,
              placeholder
            );
          }

          this.appEvents.trigger(
            `${this.composerEventPrefix}:upload-started`,
            file.name
          );
        });

        const MIN_IMAGES_TO_AUTO_GRID = 3;
        if (this.#consecutiveImages?.length >= MIN_IMAGES_TO_AUTO_GRID) {
          this.#autoGridImages();
        }
      });
    });

    this.uppyWrapper.uppyInstance.on("upload-success", (file, response) => {
      run(async () => {
        if (!this.uppyWrapper.uppyInstance) {
          return;
        }
        let upload = response.body;
        const markdown = await this.uploadMarkdownResolvers.reduce(
          (md, resolver) => resolver(upload) || md,
          getUploadMarkdown(upload)
        );

        // Only remove in progress after async resolvers finish:
        this.#removeInProgressUpload(file.id);
        cacheShortUploadUrl(upload.short_url, upload);

        new ComposerVideoThumbnailUppy(getOwner(this)).generateVideoThumbnail(
          file,
          upload.url,
          () => {
            if (this.#useUploadPlaceholders) {
              this.appEvents.trigger(
                `${this.composerEventPrefix}:replace-text`,
                this.#placeholders[file.id].uploadPlaceholder.trim(),
                markdown
              );
            }

            this.#resetUpload(file, { removePlaceholder: false });
            this.appEvents.trigger(
              `${this.composerEventPrefix}:upload-success`,
              file.name,
              upload
            );

            if (this.#inProgressUploads.length === 0) {
              this.appEvents.trigger(
                `${this.composerEventPrefix}:all-uploads-complete`
              );

              this.#displayBufferedErrors();
              this.#reset();
            }
          }
        );
      });
    });

    this.uppyWrapper.uppyInstance.on("upload-error", this._handleUploadError);

    this.uppyWrapper.uppyInstance.on("cancel-all", () => {
      // Do the manual cancelling work only if the user clicked cancel
      if (this.#userCancelled) {
        Object.values(this.#placeholders).forEach((data) => {
          run(() => {
            if (this.#useUploadPlaceholders) {
              this.appEvents.trigger(
                `${this.composerEventPrefix}:replace-text`,
                data.uploadPlaceholder,
                ""
              );
            }
          });
        });

        this.#userCancelled = false;
        this.#reset();

        this.appEvents.trigger(`${this.composerEventPrefix}:uploads-cancelled`);
      }
    });

    this.#setupPreProcessors();

    this.uppyWrapper.uppyInstance.use(DropTarget, { target: element });

    this.#uploadTargetBound = true;
    this.#bindMobileUploadButton();
  }

  @bind
  _handleUploadError(file, error, response) {
    this.#removeInProgressUpload(file.id);
    this.#resetUpload(file, { removePlaceholder: true });

    file.meta.error = error;

    if (!this.#userCancelled) {
      this.#bufferUploadError(response || error, file.name);
      this.appEvents.trigger(`${this.composerEventPrefix}:upload-error`, file);
    }
    if (this.#inProgressUploads.length === 0) {
      this.#displayBufferedErrors();
      this.#reset();
    }
  }

  #removeInProgressUpload(fileId) {
    this.#inProgressUploads = this.#inProgressUploads.filter(
      (upl) => upl.id !== fileId
    );
  }

  #displayBufferedErrors() {
    if (this.#bufferedUploadErrors.length === 0) {
      return;
    } else if (this.#bufferedUploadErrors.length === 1) {
      displayErrorForUpload(
        this.#bufferedUploadErrors[0].data,
        this.siteSettings,
        this.#bufferedUploadErrors[0].fileName
      );
    } else {
      displayErrorForBulkUpload(this.#bufferedUploadErrors);
    }
  }

  #bufferUploadError(data, fileName) {
    this.#bufferedUploadErrors.push({ data, fileName });
  }

  #setupPreProcessors() {
    const checksumPreProcessor = {
      pluginClass: UppyChecksum,
      optionsResolverFn: ({ capabilities }) => {
        return {
          capabilities,
        };
      },
    };

    // It is important that the UppyChecksum preprocessor is the last one to
    // be added; the preprocessors are run in order and since other preprocessors
    // may modify the file (e.g. the UppyMediaOptimization one), we need to
    // checksum once we are sure the file data has "settled".
    [this.uploadPreProcessors, checksumPreProcessor]
      .flat()
      .forEach(({ pluginClass, optionsResolverFn }) => {
        this.uppyWrapper.useUploadPlugin(
          pluginClass,
          optionsResolverFn({
            composerModel: this.composerModel,
            capabilities: this.capabilities,
            isMobileDevice: this.site.isMobileDevice,
          })
        );
      });

    this.uppyWrapper.onPreProcessProgress((file) => {
      let placeholderData = this.#placeholders[file.id];
      placeholderData.processingPlaceholder = `[${i18n("processing_filename", {
        filename: file.name,
      })}]()\n`;

      this.appEvents.trigger(
        `${this.composerEventPrefix}:replace-text`,
        placeholderData.uploadPlaceholder,
        placeholderData.processingPlaceholder
      );

      // Safari applies user-defined replacements to text inserted programmatically.
      // One of the most common replacements is ... -> …, so we take care of the case
      // where that transformation has been applied to the original placeholder
      this.appEvents.trigger(
        `${this.composerEventPrefix}:replace-text`,
        placeholderData.uploadPlaceholder.replace("...", "…"),
        placeholderData.processingPlaceholder
      );
    });

    this.uppyWrapper.onPreProcessComplete(
      (file) => {
        run(() => {
          let placeholderData = this.#placeholders[file.id];
          this.appEvents.trigger(
            `${this.composerEventPrefix}:replace-text`,
            placeholderData.processingPlaceholder,
            placeholderData.uploadPlaceholder
          );
        });
      },
      () => {
        run(() => {
          this.composer.setProperties({
            isProcessingUpload: false,
            isCancellable: true,
          });
          this.appEvents.trigger(
            `${this.composerEventPrefix}:uploads-preprocessing-complete`
          );
        });
      }
    );
  }

  #uploadFilenamePlaceholder(file) {
    const filename = this.#filenamePlaceholder(file);

    // when adding two separate files with the same filename search for matching
    // placeholder already existing in the editor ie [Uploading: test.png…]
    // and add order nr to the next one: [Uploading: test.png(1)…]
    const escapedFilename = escapeRegExp(filename);
    const regexString = `\\[${i18n("uploading_filename", {
      filename: escapedFilename + "(?:\\()?([0-9])?(?:\\))?",
    })}\\]\\(\\)`;
    const globalRegex = new RegExp(regexString, "g");
    const matchingPlaceholder = this.composerModel.reply.match(globalRegex);
    if (matchingPlaceholder) {
      // get last matching placeholder and its consecutive nr in regex
      // capturing group and apply +1 to the placeholder
      const lastMatch = matchingPlaceholder[matchingPlaceholder.length - 1];
      const regex = new RegExp(regexString);
      const orderNr = regex.exec(lastMatch)[1]
        ? parseInt(regex.exec(lastMatch)[1], 10) + 1
        : 1;
      return `${filename}(${orderNr})`;
    }

    return filename;
  }

  #uploadPlaceholder(file) {
    const clipboard = i18n("clipboard");
    const uploadFilenamePlaceholder = this.#uploadFilenamePlaceholder(file);
    const filename = uploadFilenamePlaceholder
      ? uploadFilenamePlaceholder
      : clipboard;

    let placeholder = `[${i18n("uploading_filename", { filename })}]()\n`;
    if (!this.#cursorIsOnEmptyLine()) {
      placeholder = `\n${placeholder}`;
    }

    return placeholder;
  }

  #useXHRUploads() {
    this.uppyWrapper.uppyInstance.use(XHRUpload, {
      endpoint: getURL(`/uploads.json?client_id=${this.messageBus.clientId}`),
      shouldRetry: () => false,
      headers: () => ({
        "X-CSRF-Token": this.session.csrfToken,
      }),
    });
  }

  #reset() {
    this.uppyWrapper.uppyInstance?.cancelAll();
    this.composer.setProperties({
      uploadProgress: 0,
      isUploading: false,
      isProcessingUpload: false,
      isCancellable: false,
    });
    this.#inProgressUploads = [];
    this.#bufferedUploadErrors = [];
    this.#consecutiveImages = [];
    this.uppyWrapper.resetPreProcessors();
    this.#fileInputEl.value = "";
  }

  #resetUpload(file, opts) {
    if (opts.removePlaceholder && this.#placeholders[file.id]) {
      this.appEvents.trigger(
        `${this.composerEventPrefix}:replace-text`,
        this.#placeholders[file.id].uploadPlaceholder,
        ""
      );
    }
  }

  @bind
  _pasteEventListener(event) {
    if (
      document.activeElement !== document.querySelector(this.editorInputClass)
    ) {
      return;
    }

    const { canUpload, canPasteHtml, types } = clipboardHelpers(event, {
      siteSettings: this.siteSettings,
      canUpload: true,
    });

    if (!canUpload || canPasteHtml || types.includes("text/plain")) {
      return;
    }

    if (event && event.clipboardData && event.clipboardData.files) {
      this._addFiles([...event.clipboardData.files], { pasted: true });
    }
  }

  @bind
  async _addFiles(files, opts = {}) {
    if (!this.session.csrfToken) {
      await updateCsrfToken();
    }

    files = Array.isArray(files) ? files : [files];

    try {
      this.uppyWrapper.uppyInstance.addFiles(
        files.map((file) => {
          return {
            source: this.uppyId,
            name: file.name,
            type: file.type,
            data: file,
            meta: { pasted: opts.pasted },
          };
        })
      );
    } catch (err) {
      warn(`error adding files to uppy: ${err}`, {
        id: "discourse.upload.uppy-add-files-error",
      });
    }
  }

  #bindMobileUploadButton() {
    if (this.site.mobileView) {
      this.mobileUploadButton = document.getElementById(
        this.mobileFileUploaderId
      );
      this.mobileUploadButton?.addEventListener(
        "click",
        this._mobileUploadButtonEventListener,
        false
      );
    }
  }

  @bind
  _mobileUploadButtonEventListener() {
    this.#fileInputEl.click();
  }

  #unbindMobileUploadButton() {
    this.mobileUploadButton?.removeEventListener(
      "click",
      this._mobileUploadButtonEventListener
    );
  }

  #filenamePlaceholder(data) {
    return data.name.replace(/\u200B-\u200D\uFEFF]/g, "");
  }

  #findMatchingUploadHandler(fileName) {
    return this.uploadHandlers.find((handler) => {
      const ext = handler.extensions.join("|");
      const regex = new RegExp(`\\.(${ext})$`, "i");
      return regex.test(fileName);
    });
  }

  #cursorIsOnEmptyLine() {
    const textArea = this.#editorEl.querySelector(this.editorInputClass);
    const selectionStart = textArea.selectionStart;
    return (
      selectionStart === 0 || textArea.value.charAt(selectionStart - 1) === "\n"
    );
  }

  #autoGridImages() {
    const reply = this.composerModel.get("reply");
    const imagesToWrapGrid = new Set(this.#consecutiveImages);

    const uploadingText = i18n("uploading_filename", {
      filename: "%placeholder%",
    });
    const uploadingTextMatch = uploadingText.match(/^.*(?=: %placeholder%…)/);

    if (!uploadingTextMatch || !uploadingTextMatch[0]) {
      return;
    }

    const uploadingImagePattern = new RegExp(
      "\\[" + uploadingTextMatch[0].trim() + ": ([^\\]]+?)\\.\\w+…\\]\\(\\)",
      "g"
    );

    const matches = reply.match(uploadingImagePattern) || [];
    const foundImages = [];

    const existingGridPattern = /\[grid\]([\s\S]*?)\[\/grid\]/g;
    const gridMatches = reply.match(existingGridPattern);

    matches.forEach((imagePlaceholder) => {
      imagePlaceholder = imagePlaceholder.trim();

      const filenamePattern = new RegExp(
        "\\[" + uploadingTextMatch[0].trim() + ": ([^\\]]+?)\\…\\]\\(\\)"
      );

      const filenameMatch = imagePlaceholder.match(filenamePattern);

      if (filenameMatch && filenameMatch[1]) {
        const filename = filenameMatch[1];

        const isWithinGrid = gridMatches?.some((gridContent) =>
          gridContent.includes(imagePlaceholder)
        );

        if (!isWithinGrid && imagesToWrapGrid.has(filename)) {
          foundImages.push(imagePlaceholder);
          imagesToWrapGrid.delete(filename);

          // Check if we've found all the images
          if (imagesToWrapGrid.size === 0) {
            return;
          }
        }
      }
    });

    // Check if all consecutive images have been found
    if (foundImages.length === this.#consecutiveImages.length) {
      const firstImageMarkdown = foundImages[0];
      const lastImageMarkdown = foundImages[foundImages.length - 1];

      const startIndex = reply.indexOf(firstImageMarkdown);
      const endIndex =
        reply.indexOf(lastImageMarkdown) + lastImageMarkdown.length;

      if (startIndex !== -1 && endIndex !== -1) {
        const textArea = this.#editorEl.querySelector(this.editorInputClass);
        if (textArea) {
          textArea.focus();
          textArea.selectionStart = startIndex;
          textArea.selectionEnd = endIndex;
          this.appEvents.trigger(
            `${this.composerEventPrefix}:apply-surround`,
            "[grid]",
            "[/grid]",
            "grid_surround",
            { useBlockMode: true }
          );
        }
      }
    }

    // Clear found images for the next consecutive images:
    this.#consecutiveImages.length = 0;
    foundImages.length = 0;
  }
}
