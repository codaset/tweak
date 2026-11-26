"use strict";
(Array.isArray(self["webpackChunkwp"]) ? self["webpackChunkwp"] : (self["webpackChunkwp"] = [])).push([["main"],{

/***/ "./src/App.jsx"
/*!*********************!*\
  !*** ./src/App.jsx ***!
  \*********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   App: () => (/* binding */ App)
/* harmony export */ });
/* harmony import */ var _Panel_jsx__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./Panel.jsx */ "./src/Panel.jsx");
/* harmony import */ var _Toolbar_jsx__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./Toolbar.jsx */ "./src/Toolbar.jsx");
/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! react/jsx-dev-runtime */ "./node_modules/react/jsx-dev-runtime.js");
var _jsxFileName = "/private/tmp/claude-501/-Users-joelmoss/7639f1dc-8d4e-4526-8560-44fdc97c31ae/scratchpad/t35/wp/src/App.jsx";



function App() {
  return /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)("main", {
    children: [/*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)("h1", {
      id: "title",
      children: "Settings"
    }, void 0, false, {
      fileName: _jsxFileName,
      lineNumber: 7,
      columnNumber: 7
    }, this), /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)(_Toolbar_jsx__WEBPACK_IMPORTED_MODULE_1__.Toolbar, {}, void 0, false, {
      fileName: _jsxFileName,
      lineNumber: 8,
      columnNumber: 7
    }, this), /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)(_Panel_jsx__WEBPACK_IMPORTED_MODULE_0__.Panel, {
      title: "Profile",
      children: /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)("button", {
        type: "button",
        "data-testid": "save",
        children: "Save"
      }, void 0, false, {
        fileName: _jsxFileName,
        lineNumber: 10,
        columnNumber: 9
      }, this)
    }, void 0, false, {
      fileName: _jsxFileName,
      lineNumber: 9,
      columnNumber: 7
    }, this)]
  }, void 0, true, {
    fileName: _jsxFileName,
    lineNumber: 6,
    columnNumber: 5
  }, this);
}

/***/ },

/***/ "./src/Button.jsx"
/*!************************!*\
  !*** ./src/Button.jsx ***!
  \************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Button: () => (/* binding */ Button)
/* harmony export */ });
/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react/jsx-dev-runtime */ "./node_modules/react/jsx-dev-runtime.js");
var _jsxFileName = "/private/tmp/claude-501/-Users-joelmoss/7639f1dc-8d4e-4526-8560-44fdc97c31ae/scratchpad/t35/wp/src/Button.jsx";

function Button({
  label
}) {
  return /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)("button", {
    type: "button",
    className: "export-button",
    children: label
  }, void 0, false, {
    fileName: _jsxFileName,
    lineNumber: 3,
    columnNumber: 5
  }, this);
}

/***/ },

/***/ "./src/Panel.jsx"
/*!***********************!*\
  !*** ./src/Panel.jsx ***!
  \***********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Panel: () => (/* binding */ Panel)
/* harmony export */ });
/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react/jsx-dev-runtime */ "./node_modules/react/jsx-dev-runtime.js");
var _jsxFileName = "/private/tmp/claude-501/-Users-joelmoss/7639f1dc-8d4e-4526-8560-44fdc97c31ae/scratchpad/t35/wp/src/Panel.jsx";

// Its children are written in App, so their owner is App, not Panel.
function Panel({
  title,
  children
}) {
  return /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)("section", {
    className: "panel",
    children: [/*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_0__.jsxDEV)("h2", {
      className: "panel-title",
      children: title
    }, void 0, false, {
      fileName: _jsxFileName,
      lineNumber: 5,
      columnNumber: 7
    }, this), children]
  }, void 0, true, {
    fileName: _jsxFileName,
    lineNumber: 4,
    columnNumber: 5
  }, this);
}

/***/ },

/***/ "./src/Toolbar.jsx"
/*!*************************!*\
  !*** ./src/Toolbar.jsx ***!
  \*************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Toolbar: () => (/* binding */ Toolbar)
/* harmony export */ });
/* harmony import */ var _Button_jsx__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./Button.jsx */ "./src/Button.jsx");
/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! react/jsx-dev-runtime */ "./node_modules/react/jsx-dev-runtime.js");
var _jsxFileName = "/private/tmp/claude-501/-Users-joelmoss/7639f1dc-8d4e-4526-8560-44fdc97c31ae/scratchpad/t35/wp/src/Toolbar.jsx";


function Toolbar() {
  return /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_1__.jsxDEV)("div", {
    className: "toolbar",
    children: /*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_1__.jsxDEV)(_Button_jsx__WEBPACK_IMPORTED_MODULE_0__.Button, {
      label: "Export"
    }, void 0, false, {
      fileName: _jsxFileName,
      lineNumber: 6,
      columnNumber: 7
    }, this)
  }, void 0, false, {
    fileName: _jsxFileName,
    lineNumber: 5,
    columnNumber: 5
  }, this);
}

/***/ },

/***/ "./src/main.jsx"
/*!**********************!*\
  !*** ./src/main.jsx ***!
  \**********************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var react_dom_client__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! react-dom/client */ "./node_modules/react-dom/client.js");
/* harmony import */ var _App_jsx__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./App.jsx */ "./src/App.jsx");
/* harmony import */ var react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! react/jsx-dev-runtime */ "./node_modules/react/jsx-dev-runtime.js");
var _jsxFileName = "/private/tmp/claude-501/-Users-joelmoss/7639f1dc-8d4e-4526-8560-44fdc97c31ae/scratchpad/t35/wp/src/main.jsx";



(0,react_dom_client__WEBPACK_IMPORTED_MODULE_0__.createRoot)(document.getElementById("root")).render(/*#__PURE__*/(0,react_jsx_dev_runtime__WEBPACK_IMPORTED_MODULE_2__.jsxDEV)(_App_jsx__WEBPACK_IMPORTED_MODULE_1__.App, {}, void 0, false, {
  fileName: _jsxFileName,
  lineNumber: 4,
  columnNumber: 52
}, undefined));

/***/ }

},
/******/ __webpack_require__ => { // webpackRuntimeModules
/******/ var __webpack_exec__ = (moduleId) => (__webpack_require__(moduleId))
/******/ __webpack_require__.O(0, ["vendor"], () => (__webpack_exec__("./src/main.jsx")));
/******/ var __webpack_exports__ = __webpack_require__.O();
/******/ }
]);
//# sourceMappingURL=main.js.map