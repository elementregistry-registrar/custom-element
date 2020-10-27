/* Copyright AnyWhichWay, LLC 2020
 GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007 */

(() => {
"use strict"
if(!window.promisedElements) {
	window.promisedElements = [];
}

const modules = window["open-modules"] || (window["open-modules"] = {});
async function require(...urls) {
	for(const url of urls) {
		if(modules[url]) {
			modules[url] = await modules[url];
			continue;
		}
		const script = document.createElement("script");
		script.setAttribute("src",url);
		modules[url] = new Promise((resolve) => {
			document.head.appendChild(script);
			script.onload = () => {
				resolve(script);
			}})
	}
	return (async () => { // don't know why we have to do this, but awaiting onload resolve is not sufficient'
		for(const key in modules) {
			modules[key] = await modules[key]; // should not have to do this
		}
	})();
}
			
function reactor(data,root) {
	const dependents = new Map(),
		type = typeof(data);
	if(data && type==="object" && !data.isReactor) {
		const proxy = new Proxy(data,{
			get(target,property) {
				if(property==="isReactor") {
					return true;
				}
				if(document.resolvingNode) {
					let set = dependents.get(property);
					if(!set) {
						set = new Set();
						dependents.set(property,set);
					}
					set.add(document.resolvingNode);
				}
				const value = target[property];
				if(value && typeof(value)==="object") {
					return reactor(value,root);
				}
				return value;
			},
			set(target,property,value) {
				if(property==="isReactor") {
					throw new Error("can't modify virtual property 'isReactor'");
				}
				if(target[property]!==value) {
					target[property] = value;
					const set = dependents.get(property);
					if(set) {
						for(const node of set) {
							if(node.isConnected) {
								resolve(node,root);
								const proto = Object.getPrototypeOf(node);
								if(node.name===property && Object.getOwnPropertyDescriptor(proto,"value")) {
									node.value = value;
								}
								if(node.render && !node.rendering) {
									node.rendering = true;
									node.render();
									node.rendering = null;
								}
							}
						}
					}
				}
				return true;
			},
			deleteProperty(target,property) {
				if(property==="isReactor") {
					throw new Error("can't delete virtual property 'isReactor'");
				}
				if(target[property]!==undefined) {
					delete target[property];
					const set = dependents.get(property);
					if(set) {
						for(const node of set) {
							if(node.isConnected) {
								resolve(node,root);
								const proto = Object.getPrototypeOf(node);
								if(node.name===property && Object.getOwnPropertyDescriptor(proto,"value")) {
									node.value = "";
								}
								if(node.render && !node.rendering) {
									node.rendering = true;
									node.render();
									node.rendering = null;
								}
							}
						}
					}
				}
			},
			ownKeys(target) {
				return Reflect.ownKeys(target);
			}
		});
		root || (root = proxy);
		return proxy;
	}
	return data;
}

function resolveAttributes(el,model,{extras,onError=(node,value,{message}) => value}={}) {
	for(let i=0;i<el.attributes.length;i++) {
		const attribute = el.attributes[i];
		let {name,value} = attribute,
			newvalue = value,
			originalvalue = el.attributes[i].originalValue || (el.attributes[i].originalValue = value);
		try {
			newvalue = originalvalue.includes("${") && model ?	Function("ctx","extras","with(ctx) { with(extras) { return `" + originalvalue + "` } }")(model,extras) : originalvalue;
			if(newvalue!==value) {
				attribute.value = newvalue;
			}
		} catch(error) {
			attribute.value = onError(el.attributes[i],originalvalue,error);
		}
		if(name==="value") {
			el.value = coerce(newvalue);
		}
	}
}
function getIterable(attributes) {
	const inameIterator = {
		foreach: (target) => target,
		forkeys: (target) => Object.keys(target),
		forvalues: (target) => Object.values(target),
		forentries: (target) => Object.entires(target)
	}
	for(let i=0;i<attributes.length;i++) {
		const attribute = attributes[i],
			name = attribute.name;
		for(const [iname,f] of Object.entries(inameIterator)) {
			if(name.startsWith(`:${iname}`)) {
				const iterator = "forEach",
					target = JSON.parse(attribute.value),
					iterable = f(target),
					match = (name.match(/\((.*?)\)/g)[0]||""),
					argNames = match.substring(1,match.length-1).split(",");
				return {iterator,iterable,argNames};
			}
		}
	}
}
function extractBalanced(string) {
	const matches = [];
	let quoted;
	for(let i=0;i<string.length;i++) {
		if(["'",'"'].includes(string[i])) {
			quoted = !quoted;
			while(quoted) {
				i++;
				if(i===string.length) {
					return matches;
				}
				if(["'",'"'].includes(string[i])) {
					quoted = !quoted;
				}
			}
		}
		if(string[i]==="$" && string[i+1]==="{") {
			let j = i + 2,
				count = 1;
			while(count>0) {
				j++;
				if(j>string.length) {
					return matches;
				}
				if(string[j]==="$" && string[j+1]==="{") {
					count++;
					continue;
				}
				if(string[j]==="}") {
					count--;
				}
			}
			matches.push(string.substring(i,j+1))
			i = j;
		}
	}
	return matches;
}
function compileScript(script,model,{onError,extras},recursing) {
	script = recursing ? script.replace(/<[\/a-zA-Z]+(>|.*?[^?]>)/g,(match) => `"${match}"`) : script;
	const text = script.substring(1,script.length-1),
		matches = extractBalanced(text);
	if(matches.length===0) {
		return script;
	}
	script = recursing ? matches.reduce((accum,match) => accum.replace(match,`\`${match}\`+`),script) : script;
	return matches.reduce((accum,match) => accum = accum.replace(match,compileScript(match,model,{onError,extras},true)),script);
}
function resolve(node,model={},{unhide,extras={},onError=(node,value,{message}) => value}={}) {
	if(!node.model) {
		Object.defineProperty(node,"model",{value:model})
	}
	document.resolvingNode = node;
	node.originalData || (node.originalData = node.data);
	if(node.tagName==="SCRIPT" && node.getAttribute("type")==="application/tlx") {
		node.id || (node.id = (Math.random()+"").substring(2));
		node.originalText || (node.originalText = node.innerText);
		const text = node.originalText;// .replace(/<[\/a-zA-Z]+(>|.*?[^?]>)/g,(match) => `"${match}"`);
		let code = compileScript("${${" + text + "}}",model,{onError,extras}).trim();
		code = code.substring(4,code.length-2); // remove surrounding ${}
		code = code.replace(/\+;/g,";");
		node.innerText = code;
		node.setAttribute("type","application/javascript");
	} else if(node.nodeType===Node.TEXT_NODE && node.originalData.includes("${")) {
		try {
			node.data = Function("ctx","extras","with(ctx) { with(extras) { return `" + node.originalData + "`} }")(model,extras);
		} catch(error) {
			node.data = onError(node,node.originalData,error)
		}
	} else if (node.childNodes) {
		let iteration;
		if(node.attributes && node.attributes.length>0) {
			resolveAttributes(node,model,{onError,extras});
			if(node.getAttribute(":if")==="false") {
				node.style.display = "none";
			} else {
				iteration = getIterable(node.attributes);
			}
		}
		if(iteration) {
			node.originalChildNodes || (node.originalChildNodes = [].slice.call(node.childNodes).map((node) => node.cloneNode(true)));
			while(node.lastChild) {
				node.lastChild.remove();
			}
			const {iterator,iterable,argNames} = iteration,
				[key1="currentValue",key2="index",key3="array"] = argNames;
			iterable[iterator]((arg1,arg2,arg3) => {
				for(const child of node.originalChildNodes) {
					const extras = {[key1]:arg1,[key2]:arg2,[key3]:arg3},
						clone = child.cloneNode(true);
					resolve(clone,model,{onError,extras});
					node.appendChild(clone);
				}
			})
		} else {
			for(const child of node.childNodes) {
				resolve(child,model,{onError,extras});
			}
		}
	}
	if(node.shadowRoot) {
		resolve(node.shadowRoot,model,{onError,extras});
	}
	if(unhide) {
		node.removeAttribute("hidden");
	}
	return node;
}

function coerce(value) {
	if(typeof(value)==="string") {
		try {
			return JSON.parse(value);
		} catch(error) {
			
		}
	}
	return value;
}

function getAttributes(el,filter=(attribute)=>attribute) {
	const attributes = {};
	for(let i=0;i<el.attributes.length;i++) {
		if(filter(el.attributes[i])) {
			const {name,value} = el.attributes[i];
			attributes[name] = value==="" ? true : coerce(value);
		}
	}
	if(!attributes.title) {
		attributes.title = "";
	}
	return attributes;
}

function parse(html,config) {
	config.error = null;
	const body = new DOMParser().parseFromString(html,"text/html").body;
	let	text = config.text = body.innerText.trim(),
		json,
		script;
	config.html = html = body.innerHTML.trim();
	if((text[0]==="{" || text[0]==="[") || config.type==="application/json")  {
		try {
			json = config.json = RJSON.parse(text);
			text = config.html = config.text = JSON.stringify(json,null,2);
		} catch(error) {
			json = config.error = config.json = error;
		}
	} else if(text && config.type==="application/javascript") {
		try {
			script = config.script = Function("return async function(view) { " + text + "}")();
		} catch(error) {
			script = config.error = config.script = error;
		}
	}
	return {html,text,json,script}
}

function getFontWidth(el)
{
	var div = document.createElement('div');
	div.style.width = "1000em";
	el.appendChild(div);
	var pixels = div.offsetWidth / 1000;
	el.removeChild(div);
	return pixels;
}

function getConfig(template,el) {
	let view,
		html = el.innerHTML.trim(),
		previous,
		parametersource = el.getAttribute("parameters"),
		parameterel = parametersource==="<" ? el.previousElementSibling : parametersource===">" ? el.nextElementSibling : (parametersource!==null ? document.getElementById(parametersource) : null);
	if(parametersource!==null && !parameterel) {
		throw new Error(`parameter source ${parametersource} missing`);
	}
	if(!html && parameterel) {
		previous = parametersource==="" ? el.previousElementSibling : undefined;
		html =  parameterel.innerHTML.trim();
	}
	const type = template.getAttribute("type"),
		tagname = template.getAttribute("tagname"),
		tattributes = getAttributes(template,({name}) => !["id","tagname","type","observe","bindinputs"].includes(name)),
		eattributes = getAttributes(el),
		attributes = {...tattributes,...eattributes},
		config = {type,attributes,previous,parameterSource:parameterel};
	parse(html,config);
	if(eattributes.view) {
		view = document.getElementById(eattributes.view);
		if(!view) {
			throw new Error(`Unable to find view #${view} for ${tagname}`)
		}
	} else {
		view = document.createElement("div");
		view.id = (Math.random()+"").substring(2);
		el.shadowRoot.appendChild(view);
	}
	//if(!eattributes.view) {
	//	el.after(target);
	//}
	config.view = view;
	if(attributes.isolate || config.script) {
		config.isolate = true;
	}
	return config;
}

function replaceVariables(text) {
	const matches = text.match(/\$\#.*\b/g)||[];
	matches.forEach((variable) => {
		const el = document.getElementById(variable.substring(2));
		if(el) {
			text = text.replace(variable,el.innerText);
		}
	});
	return text;
}

const defined = {};
const isolates = window.customElementIsolates || (window.customElementIsolates = []);
setTimeout(() => {
	const div = document.createElement("div");
	div.style.height = "120vh";
	div.id = "customElementsLoading";
	document.body.style.overflow = "hidden";
	if(document.body.firstChild) {
		if(document.body.firstChild.id!=="customElementsLoading") {
			document.body.firstChild.before(div);
		}
	} else {
		document.body.appendChild(div);
	}
});
setTimeout(() => {
	const el = document.getElementById("customElementsLoading");
	!el || el.remove();
},1500);
setTimeout(async () => {
	await Promise.all(window.customElementIsolates);
	document.body.style.overflow = "initial";
},3000);
setTimeout(async () => {
	window.customElementIsolates = [];
	document.body.style.overflow = "initial";
},6000);
let oldwindowwidth = window.innerWidth;
window.addEventListener("resize",(event) => {
	let timeout;
	if(event.target===window) {
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			if(oldwindowwidth!==window.innerWidth) {
				oldwindowwidth = window.innerWidth;		
				const frames = [].slice.call(document.body.querySelectorAll("iframe")||[]);
				frames.forEach((frame) => {
					if((!frame.contentDocument.body || frame.contentDocument.body.scrollWidth!==window.innerWidth) && frame.run) {
						frame.style.maxWidth = window.innerWidth;
					}
				})
			}
		})
	}
})
async function compileTemplate(template,url) {
	const tagname = template.getAttribute("tagname"),
			extend = template.hasAttribute("extends") ? Function("return " + template.getAttribute("extends"))() : HTMLElement,
			clone = template.cloneNode(true);
	if(["Function","eval"].some((term) => template.innerHTML.includes(term))) {
		template.setAttribute("isolate","");
	}
	if(tagname && !defined[tagname]) {
		defined[tagname] = true;
		const observe = clone.getAttribute("observe"),
			observed = observe ? observe.split(",") : [];
		try {
			customElements.define(tagname,
				class extends extend {
					constructor(model={}) {
						super();
						if(!this.parentElement) {
							return;
						}
						if(!this.model) {
							Object.defineProperty(this,"model",{value:reactor(model)});
						}
						const shadowRoot = this.attachShadow({mode: 'open'});
						
						if(this.attributes["expose-element"]) {
							const span = document.createElement("span");
							span.innerText = this.outerHTML;
							shadowRoot.appendChild(span);
						}
						
						const config = getConfig(template,this);
						
						if(config.attributes["hide-parameters"]) {
							config.parameterSource.setAttribute("hidden","");
						}
						
						const isolatecount = isolates.length;
						if(config.isolate && globalThis) {
							const iframe = document.createElement("iframe"),
								run = () => {
									const 
										parametersource = config.parameterSource ? config.parameterSource.outerHTML : "",
										html = this.outerHTML.replace(/>\s*<\//,`>${config.text}</`),
										styles = document.getElementById("downrunnerStyles");
									iframe.setAttribute("scrolling","no")
									if(config.attributes.sandbox) {
										iframe.setAttribute("sandbox",config.attributes.sandbox);
									}
									iframe.style.border = 0;
									iframe.style.maxWidth = window.innerWidth;
									iframe.srcdoc = `${styles ? styles.outerHTML : ""}` +
										`<script>globalThis=null; window.parent=null; Object.defineProperty(window,"frameElement",{value:null});</script>` +
										`<script src="${currentScript.getAttribute('src')}" templates="${url}"></script>` +
										`${config.view ? `<div id="${config.view.id}"></div>` : ''}` +
										`<script>document.body.style.margin=0;document.body.style.padding=0</script>` +
										`${parametersource}` +
										`${html}`;
									this.after(iframe);
									let resolved,
										originalwidth;
									// pause for rendering
									isolates[isolatecount] = null;
									const promised = new Promise(async (resolve) => {
										await Promise.all(isolates);
										setTimeout(() => {
											if(!resolved) {
												resolved = true;
												resolve();
											}
										},1000);
										setInterval(() => {
											if(iframe.contentDocument.body) {
													const height = parseInt(iframe.height)||0,
													scrollheight = parseInt(iframe.contentDocument.body.scrollHeight),
													width = parseInt(iframe.width)||0,
													scrollwidth = parseInt(iframe.contentDocument.body.scrollWidth);
												/*if(originalwidth && width>originalwidth && originalwidth<window.innerWidth && width>window.innerWidth) {
													iframe.remove();
													clearInterval(interval);
													this.run();
												}*/
												if(!originalwidth) {
													originalwidth = width;
												}
												if(scrollheight===height-10 && scrollwidth===width && !resolved) {
													resolved = true;
													resolve();
													return;
												}
												if(scrollheight!==height-10) {
													iframe.setAttribute("height",scrollheight+10+"px");
												}
												if(scrollwidth>width) {
													iframe.setAttribute("width",scrollwidth+"px");
												}
											}
										},250)
									}).then(() => {
										isolates.splice(isolatecount-1,1);
									})
									isolates[isolatecount] = promised;
								};
							this.run = iframe.run = run;
							run();
						}
						if(isolates.length>isolatecount) {
							return;
						}
						// pause for rendering to avoid vertial repaints if possible
						Promise.all(isolates).then(() => {
							Object.entries(config.attributes).forEach(([key,value]) => {
								if(value && typeof(value)==="object") {
									this.setAttribute(key,JSON.stringify(value))
								} else {
									this.setAttribute(key,value)
								}
								this[key] = value;
							});
							let editor;
							if(config.attributes.editable) {
								editor = shadowRoot.querySelector("editor");
								if(!editor) {
									editor = document.createElement("textarea");
									editor.style.display = "block";
									editor.value = config.html||"";
									const lines = (editor.value.match(/.*\n/g)||[]),
										linecount = Math.max(lines.length,2);
									editor.style.height = `${Math.min(10,linecount)}em`;
									if(shadowRoot.firstElementChild) {
										shadowRoot.firstElementChild.before(editor);
									} else {
										shadowRoot.appendChild(editor);
									}
									editor.addEventListener("keyup",() => run(editor.value));
								}
							}
							for(const child of clone.content.childNodes) {
								if(child===clone.content.lastElementChild && child.tagName==="SCRIPT") {
									if(child.getAttribute("type")==="application/tlx") {
										resolve(child,model,{extras:config.attributes});
									}
									continue;
								}
								const childclone = child.cloneNode(true);
								shadowRoot.appendChild(childclone);
							}
							shadowRoot.normalize();
							resolve(this,model,{extras:config.attributes});
							if(clone.hasAttribute("bindinputs")) {
								const bindinputs = clone.getAttribute("bindinputs").split(",");
								this.importInputs(...bindinputs);
							}
							
							
							const parameters  = {attributes:config.attributes},
								run = (text=editor ? editor.value : config.text) => {
									text = replaceVariables(text);
									if(clone.content.lastElementChild.tagName==="SCRIPT" && (!clone.content.lastElementChild.hasAttribute("type") || ["text/javascript","application/javascript","javascript"].includes(clone.content.lastElementChild.getAttribute("type")))) {
										const f = new Function("return async function(globalThis,model,RJSON,require,document,parameters,view,editor) { with(model) { " + clone.content.lastElementChild.innerText + " } }")();
										Object.assign(parameters,parse(text,config));
										if(shadowRoot.firstElementChild && shadowRoot.firstElementChild.tagName==="ERROR") {
											shadowRoot.firstElementChild.remove();
										}
										if(config.error) {
											const message = document.createElement("error");
											message.innerText = config.error;
											if(shadowRoot.firstElementChild) {
												shadowRoot.firstElementChild.before(message);
											} else {
												shadowRoot.appendChild(message);
											}
										} else {
											f.call(this,null,this.model,RJSON,require,document,parameters,config.view,editor);
										}
									}
									if(editor) {
										setInterval(() => {
											const lines = (editor.value.match(/.*\n/g)||[]),
												fontsize = getFontWidth(config.view),
												maxwidth = lines.reduce((accum,line) => accum = Math.max(accum,line.length),80) * fontsize,
												scrollwidth = parseInt(config.view.scrollWidth),
												width = maxwidth > scrollwidth ? 80 * fontsize : scrollwidth,
												newwidth = Math.min(parseInt(editor.style.width),Math.min(window.innerWidth-35,width))+"px";
											if(editor.style.width!==newwidth) {
												editor.style.width=newwidth;
											}
										},500);
									}
								};
							this.run = run;
							run(config.text);
							window.addEventListener("resize",() => {
								run()
							});
							while(this.lastChild) {
								this.lastChild.remove();
							}
						})
					}
					setAttribute(name,newValue) {
						const oldValue = this.getAttribute(name);
						super.setAttribute(name,newValue);
						if(observed.includes(name)) {
							this.attributeChangedCallback(name,oldValue,newValue);
						}
					}
					connectedCallback() {
						if(this.connected) {
							this.connected();
						}
						if(this.render) {
							document.resolvingNode = this;
							this.render();
						}
					}
					disconnectedCallback() {
						if(this.disconnected) {
							this.disconnected();
						}
					}
					adoptedCallback() {
						if(this.adopted) {
							this.adopted();
						}
					}
					attributeChangedCallback(name,oldValue,newValue) {
						if(this.attributeChanged) {
							this.attributeChanged(name,oldValue,newValue);
						}
					}
					importInputs(...names) {
						names = names.filter((name) => name!=="")
						let inputs = [].slice.call(this.shadowRoot.querySelectorAll("input[name], select[name], textarea[name]"));
						const model = this.model;
						if(names.length>0) inputs = inputs.filter((input) => names.includes(input.getAttribute("name")));
						inputs.forEach((input) => {
							document.resolvingNode = input;
							const name = input.name,
								existingvalue = model[name];
							let	value = coerce(input.value);
							if(value==="" && input.hasAttribute("default")) {
								value = input.value = coerce(input.getAttribute("default"));
							}
							if((value==null || value==="") && existingvalue!=null) {
								input.setAttribute("value",typeof(existingvalue)==="string" ? existingvalue : JSON.stringify(existingvalue));
								input.value = existingvalue;
							}
							Object.defineProperty(model,name,{enumerable:true,configurable:true,writable:true});
							if(input.type==="radio") {
								if(input.checked) {
									model[name] = value;
								}
								input.addEventListener("click",() => model[name] = coerce(input.value))
								return;
							}
							if(input.type==="checkbox") {
								model[name] = input.checked;
								input.addEventListener("click",() => model[name] = input.checked);
								return;
							}
							if(input.tagName==="SELECT") {
								if(input.multiple) {
									model[name] = [];
								}
								input.addEventListener("change",() => model[name] = input.multiple ? input.value.split(",").map(value => coerce(value)) : coerce(input.value))
								for(let i=0;i<input.options.length;i++) {
									const option = inout.options[i];
									if(option.selected) {
										const value = coerce(option.value);
										if(input.multiple) {
											model[name].push(value)
										} else {
											model[name] = value;
											break;
										}
									}
								}
								return;
							}
							model[name] = value;
							input.addEventListener("change",() => this.model[name] = input.multiple ? input.value.split(",").map(value => coerce(value))  : coerce(input.value))
						})
					}
				}
			);	
			template.remove();
		} catch(error) {
			;
		}
	}
}
	
	const currentScript = document.currentScript,
		scripturl = new URL(currentScript.getAttribute("src")),
		urlbase = `${scripturl.protocol}//${scripturl.host}`,
		templates = currentScript.getAttribute("templates");
	if(!templates) {
		return;
	}
	(async () => {
		await require("https://www.unpkg.com/relaxed-json@1.0.3/relaxed-json.js");
		templates.split(",").forEach((template) => {
			if(template.startsWith("http")||template.includes("/")||template.endsWith(".html")) {
				if(!template.startsWith("http")) {
					template = template.startsWith("/") ? urlbase + template : urlbase + "/" + template;
				}
				if(!template.endsWith(".html")) {
					if(!template.endsWith("/")) {
						template += "/";	
					}
					template += "index.html";
				}
				window.promisedElements.push(new Promise(async (resolve) => {
					const response = await fetch(template),
						html = await response.text(),
						dom =new DOMParser().parseFromString(html,"text/html"),
						tagname = dom.head.firstElementChild.getAttribute("tagname")||dom.head.firstElementChild.id;
					compileTemplate(dom.head.firstElementChild,template);
					resolve(tagname);
				}));
			} else {
				window.promisedElements.push(new Promise(async (resolve) => {
					const el = document.querySelector(`[tagname="${template}"]`);
					compileTemplate(el);
					resolve(el.getAttribute("tagname")||el.id);
				}));
			}
		})
	})();
})();
=======
(() => {
"use strict"
if(!window.promisedElements) {
	window.promisedElements = [];
}

const modules = window["open-modules"] || (window["open-modules"] = {});
async function require(...urls) {
	for(const url of urls) {
		if(modules[url]) {
			modules[url] = await modules[url];
			continue;
		}
		const script = document.createElement("script");
		script.setAttribute("src",url);
		modules[url] = new Promise((resolve) => {
			document.head.appendChild(script);
			script.onload = () => {
				resolve(script);
			}})
	}
	return (async () => { // don't know why we have to do this, but awaiting onload resolve is not sufficient'
		for(const key in modules) {
			modules[key] = await modules[key]; // should not have to do this
		}
	})();
}
			
function reactor(data,root) {
	const dependents = new Map(),
		type = typeof(data);
	if(data && type==="object" && !data.isReactor) {
		const proxy = new Proxy(data,{
			get(target,property) {
				if(property==="isReactor") {
					return true;
				}
				if(document.resolvingNode) {
					let set = dependents.get(property);
					if(!set) {
						set = new Set();
						dependents.set(property,set);
					}
					set.add(document.resolvingNode);
				}
				const value = target[property];
				if(value && typeof(value)==="object") {
					return reactor(value,root);
				}
				return value;
			},
			set(target,property,value) {
				if(property==="isReactor") {
					throw new Error("can't modify virtual property 'isReactor'");
				}
				if(target[property]!==value) {
					target[property] = value;
					const set = dependents.get(property);
					if(set) {
						for(const node of set) {
							if(node.isConnected) {
								resolve(node,root);
								const proto = Object.getPrototypeOf(node);
								if(node.name===property && Object.getOwnPropertyDescriptor(proto,"value")) {
									node.value = value;
								}
								if(node.render && !node.rendering) {
									node.rendering = true;
									node.render();
									node.rendering = null;
								}
							}
						}
					}
				}
				return true;
			},
			deleteProperty(target,property) {
				if(property==="isReactor") {
					throw new Error("can't delete virtual property 'isReactor'");
				}
				if(target[property]!==undefined) {
					delete target[property];
					const set = dependents.get(property);
					if(set) {
						for(const node of set) {
							if(node.isConnected) {
								resolve(node,root);
								const proto = Object.getPrototypeOf(node);
								if(node.name===property && Object.getOwnPropertyDescriptor(proto,"value")) {
									node.value = "";
								}
								if(node.render && !node.rendering) {
									node.rendering = true;
									node.render();
									node.rendering = null;
								}
							}
						}
					}
				}
			},
			ownKeys(target) {
				return Reflect.ownKeys(target);
			}
		});
		root || (root = proxy);
		return proxy;
	}
	return data;
}

function resolveAttributes(el,model,{extras,onError=(node,value,{message}) => value}={}) {
	for(let i=0;i<el.attributes.length;i++) {
		const attribute = el.attributes[i];
		let {name,value} = attribute,
			newvalue = value,
			originalvalue = el.attributes[i].originalValue || (el.attributes[i].originalValue = value);
		try {
			newvalue = originalvalue.includes("${") && model ?	Function("ctx","extras","with(ctx) { with(extras) { return `" + originalvalue + "` } }")(model,extras) : originalvalue;
			if(newvalue!==value) {
				attribute.value = newvalue;
			}
		} catch(error) {
			attribute.value = onError(el.attributes[i],originalvalue,error);
		}
		if(name==="value") {
			el.value = coerce(newvalue);
		}
	}
}
function getIterable(attributes) {
	const inameIterator = {
		foreach: (target) => target,
		forkeys: (target) => Object.keys(target),
		forvalues: (target) => Object.values(target),
		forentries: (target) => Object.entires(target)
	}
	for(let i=0;i<attributes.length;i++) {
		const attribute = attributes[i],
			name = attribute.name;
		for(const [iname,f] of Object.entries(inameIterator)) {
			if(name.startsWith(`:${iname}`)) {
				const iterator = "forEach",
					target = JSON.parse(attribute.value),
					iterable = f(target),
					match = (name.match(/\((.*?)\)/g)[0]||""),
					argNames = match.substring(1,match.length-1).split(",");
				return {iterator,iterable,argNames};
			}
		}
	}
}
function extractBalanced(string) {
	const matches = [];
	let quoted;
	for(let i=0;i<string.length;i++) {
		if(["'",'"'].includes(string[i])) {
			quoted = !quoted;
			while(quoted) {
				i++;
				if(i===string.length) {
					return matches;
				}
				if(["'",'"'].includes(string[i])) {
					quoted = !quoted;
				}
			}
		}
		if(string[i]==="$" && string[i+1]==="{") {
			let j = i + 2,
				count = 1;
			while(count>0) {
				j++;
				if(j>string.length) {
					return matches;
				}
				if(string[j]==="$" && string[j+1]==="{") {
					count++;
					continue;
				}
				if(string[j]==="}") {
					count--;
				}
			}
			matches.push(string.substring(i,j+1))
			i = j;
		}
	}
	return matches;
}
function compileScript(script,model,{onError,extras},recursing) {
	script = recursing ? script.replace(/<[\/a-zA-Z]+(>|.*?[^?]>)/g,(match) => `"${match}"`) : script;
	const text = script.substring(1,script.length-1),
		matches = extractBalanced(text);
	if(matches.length===0) {
		return script;
	}
	script = recursing ? matches.reduce((accum,match) => accum.replace(match,`\`${match}\`+`),script) : script;
	return matches.reduce((accum,match) => accum = accum.replace(match,compileScript(match,model,{onError,extras},true)),script);
}
function resolve(node,model={},{unhide,extras={},onError=(node,value,{message}) => value}={}) {
	if(!node.model) {
		Object.defineProperty(node,"model",{value:model})
	}
	document.resolvingNode = node;
	node.originalData || (node.originalData = node.data);
	if(node.tagName==="SCRIPT" && node.getAttribute("type")==="application/tlx") {
		node.id || (node.id = (Math.random()+"").substring(2));
		node.originalText || (node.originalText = node.innerText);
		const text = node.originalText;// .replace(/<[\/a-zA-Z]+(>|.*?[^?]>)/g,(match) => `"${match}"`);
		let code = compileScript("${${" + text + "}}",model,{onError,extras}).trim();
		code = code.substring(4,code.length-2); // remove surrounding ${}
		code = code.replace(/\+;/g,";");
		node.innerText = code;
		node.setAttribute("type","application/javascript");
	} else if(node.nodeType===Node.TEXT_NODE && node.originalData.includes("${")) {
		try {
			node.data = Function("ctx","extras","with(ctx) { with(extras) { return `" + node.originalData + "`} }")(model,extras);
		} catch(error) {
			node.data = onError(node,node.originalData,error)
		}
	} else if (node.childNodes) {
		let iteration;
		if(node.attributes && node.attributes.length>0) {
			resolveAttributes(node,model,{onError,extras});
			if(node.getAttribute(":if")==="false") {
				node.style.display = "none";
			} else {
				iteration = getIterable(node.attributes);
			}
		}
		if(iteration) {
			node.originalChildNodes || (node.originalChildNodes = [].slice.call(node.childNodes).map((node) => node.cloneNode(true)));
			while(node.lastChild) {
				node.lastChild.remove();
			}
			const {iterator,iterable,argNames} = iteration,
				[key1="currentValue",key2="index",key3="array"] = argNames;
			iterable[iterator]((arg1,arg2,arg3) => {
				for(const child of node.originalChildNodes) {
					const extras = {[key1]:arg1,[key2]:arg2,[key3]:arg3},
						clone = child.cloneNode(true);
					resolve(clone,model,{onError,extras});
					node.appendChild(clone);
				}
			})
		} else {
			for(const child of node.childNodes) {
				resolve(child,model,{onError,extras});
			}
		}
	}
	if(node.shadowRoot) {
		resolve(node.shadowRoot,model,{onError,extras});
	}
	if(unhide) {
		node.removeAttribute("hidden");
	}
	return node;
}

function coerce(value) {
	if(typeof(value)==="string") {
		try {
			return JSON.parse(value);
		} catch(error) {
			
		}
	}
	return value;
}

function getAttributes(el,filter=(attribute)=>attribute) {
	const attributes = {};
	for(let i=0;i<el.attributes.length;i++) {
		if(filter(el.attributes[i])) {
			const {name,value} = el.attributes[i];
			attributes[name] = value==="" ? true : coerce(value);
		}
	}
	if(!attributes.title) {
		attributes.title = "";
	}
	return attributes;
}

function parse(html,config) {
	config.error = null;
	const body = new DOMParser().parseFromString(html,"text/html").body;
	let	text = config.text = body.innerText.trim(),
		json,
		script;
	config.html = html = body.innerHTML.trim();
	if((text[0]==="{" || text[0]==="[") || config.type==="application/json")  {
		try {
			json = config.json = RJSON.parse(text);
			text = config.html = config.text = JSON.stringify(json,null,2);
		} catch(error) {
			json = config.error = config.json = error;
		}
	} else if(text && config.type==="application/javascript") {
		try {
			script = config.script = Function("return async function(view) { " + text + "}")();
		} catch(error) {
			script = config.error = config.script = error;
		}
	}
	return {html,text,json,script}
}

function getFontWidth(el)
{
	var div = document.createElement('div');
	div.style.width = "1000em";
	el.appendChild(div);
	var pixels = div.offsetWidth / 1000;
	el.removeChild(div);
	return pixels;
}

function getConfig(template,el) {
	let view,
		html = el.innerHTML.trim(),
		previous,
		parametersource = el.getAttribute("parameters"),
		parameterel = parametersource==="<" ? el.previousElementSibling : parametersource===">" ? el.nextElementSibling : (parametersource!==null ? document.getElementById(parametersource) : null);
	if(parametersource!==null && !parameterel) {
		throw new Error(`parameter source ${parametersource} missing`);
	}
	if(!html && parameterel) {
		previous = parametersource==="" ? el.previousElementSibling : undefined;
		html =  parameterel.innerHTML.trim();
	}
	const type = template.getAttribute("type"),
		tagname = template.getAttribute("tagname"),
		tattributes = getAttributes(template,({name}) => !["id","tagname","type","observe","bindinputs"].includes(name)),
		eattributes = getAttributes(el),
		attributes = {...tattributes,...eattributes},
		config = {type,attributes,previous,parameterSource:parameterel};
	parse(html,config);
	if(eattributes.view) {
		view = document.getElementById(eattributes.view);
		if(!view) {
			throw new Error(`Unable to find view #${view} for ${tagname}`)
		}
	} else {
		view = document.createElement("div");
		view.id = (Math.random()+"").substring(2);
		el.shadowRoot.appendChild(view);
	}
	//if(!eattributes.view) {
	//	el.after(target);
	//}
	config.view = view;
	if(attributes.isolate || config.script) {
		config.isolate = true;
	}
	return config;
}

function replaceVariables(text) {
	const matches = text.match(/\$\#.*\b/g)||[];
	matches.forEach((variable) => {
		const el = document.getElementById(variable.substring(2));
		if(el) {
			text = text.replace(variable,el.innerText);
		}
	});
	return text;
}

const defined = {};
const isolates = window.customElementIsolates || (window.customElementIsolates = []);
setTimeout(() => {
	const div = document.createElement("div");
	div.style.height = "120vh";
	div.id = "customElementsLoading";
	document.body.style.overflow = "hidden";
	if(document.body.firstChild) {
		if(document.body.firstChild.id!=="customElementsLoading") {
			document.body.firstChild.before(div);
		}
	} else {
		document.body.appendChild(div);
	}
});
setTimeout(() => {
	const el = document.getElementById("customElementsLoading");
	!el || el.remove();
},1500);
setTimeout(async () => {
	await Promise.all(window.customElementIsolates);
	document.body.style.overflow = "initial";
},3000);
setTimeout(async () => {
	window.customElementIsolates = [];
	document.body.style.overflow = "initial";
},6000);
let oldwindowwidth = window.innerWidth;
window.addEventListener("resize",(event) => {
	let timeout;
	if(event.target===window) {
		clearTimeout(timeout);
		timeout = setTimeout(() => {
			if(oldwindowwidth!==window.innerWidth) {
				oldwindowwidth = window.innerWidth;		
				const frames = [].slice.call(document.body.querySelectorAll("iframe")||[]);
				frames.forEach((frame) => {
					if((!frame.contentDocument.body || frame.contentDocument.body.scrollWidth!==window.innerWidth) && frame.run) {
						frame.style.maxWidth = window.innerWidth;
					}
				})
			}
		})
	}
})
async function compileTemplate(template,url) {
	const tagname = template.getAttribute("tagname"),
			extend = template.hasAttribute("extends") ? Function("return " + template.getAttribute("extends"))() : HTMLElement,
			clone = template.cloneNode(true);
	if(["Function","eval"].some((term) => template.innerHTML.includes(term))) {
		template.setAttribute("isolate","");
	}
	if(tagname && !defined[tagname]) {
		defined[tagname] = true;
		const observe = clone.getAttribute("observe"),
			observed = observe ? observe.split(",") : [];
		try {
			customElements.define(tagname,
				class extends extend {
					constructor(model={}) {
						super();
						if(!this.parentElement) {
							return;
						}
						if(!this.model) {
							Object.defineProperty(this,"model",{value:reactor(model)});
						}
						const shadowRoot = this.attachShadow({mode: 'open'});
						
						if(this.attributes["expose-element"]) {
							const span = document.createElement("span");
							span.innerText = this.outerHTML;
							shadowRoot.appendChild(span);
						}
						
						const config = getConfig(template,this);
						
						if(config.attributes["hide-parameters"]) {
							config.parameterSource.setAttribute("hidden","");
						}
						
						const isolatecount = isolates.length;
						if(config.isolate && globalThis) {
							const iframe = document.createElement("iframe"),
								run = () => {
									const 
										parametersource = config.parameterSource ? config.parameterSource.outerHTML : "",
										html = this.outerHTML.replace(/>\s*<\//,`>${config.text}</`),
										styles = document.getElementById("downrunnerStyles");
									iframe.setAttribute("scrolling","no")
									if(config.attributes.sandbox) {
										iframe.setAttribute("sandbox",config.attributes.sandbox);
									}
									iframe.style.border = 0;
									iframe.style.maxWidth = window.innerWidth;
									iframe.srcdoc = `${styles ? styles.outerHTML : ""}` +
										`<script>globalThis=null; window.parent=null; Object.defineProperty(window,"frameElement",{value:null});</script>` +
										`<script src="${currentScript.getAttribute('src')}" templates="${url}"></script>` +
										`${config.view ? `<div id="${config.view.id}"></div>` : ''}` +
										`<script>document.body.style.margin=0;document.body.style.padding=0</script>` +
										`${parametersource}` +
										`${html}`;
									this.after(iframe);
									let resolved,
										originalwidth;
									// pause for rendering
									isolates[isolatecount] = null;
									const promised = new Promise(async (resolve) => {
										await Promise.all(isolates);
										setTimeout(() => {
											if(!resolved) {
												resolved = true;
												resolve();
											}
										},1000);
										setInterval(() => {
											if(iframe.contentDocument.body) {
													const height = parseInt(iframe.height)||0,
													scrollheight = parseInt(iframe.contentDocument.body.scrollHeight),
													width = parseInt(iframe.width)||0,
													scrollwidth = parseInt(iframe.contentDocument.body.scrollWidth);
												/*if(originalwidth && width>originalwidth && originalwidth<window.innerWidth && width>window.innerWidth) {
													iframe.remove();
													clearInterval(interval);
													this.run();
												}*/
												if(!originalwidth) {
													originalwidth = width;
												}
												if(scrollheight===height-10 && scrollwidth===width && !resolved) {
													resolved = true;
													resolve();
													return;
												}
												if(scrollheight!==height-10) {
													iframe.setAttribute("height",scrollheight+10+"px");
												}
												if(scrollwidth>width) {
													iframe.setAttribute("width",scrollwidth+"px");
												}
											}
										},250)
									}).then(() => {
										isolates.splice(isolatecount-1,1);
									})
									isolates[isolatecount] = promised;
								};
							this.run = iframe.run = run;
							run();
						}
						if(isolates.length>isolatecount) {
							return;
						}
						// pause for rendering to avoid vertial repaints if possible
						Promise.all(isolates).then(() => {
							Object.entries(config.attributes).forEach(([key,value]) => {
								if(value && typeof(value)==="object") {
									this.setAttribute(key,JSON.stringify(value))
								} else {
									this.setAttribute(key,value)
								}
								this[key] = value;
							});
							let editor;
							if(config.attributes.editable) {
								editor = shadowRoot.querySelector("editor");
								if(!editor) {
									editor = document.createElement("textarea");
									editor.style.display = "block";
									editor.value = config.html||"";
									const lines = (editor.value.match(/.*\n/g)||[]),
										linecount = Math.max(lines.length,2);
									editor.style.height = `${Math.min(10,linecount)}em`;
									if(shadowRoot.firstElementChild) {
										shadowRoot.firstElementChild.before(editor);
									} else {
										shadowRoot.appendChild(editor);
									}
									editor.addEventListener("keyup",() => run(editor.value));
								}
							}
							for(const child of clone.content.childNodes) {
								if(child===clone.content.lastElementChild && child.tagName==="SCRIPT") {
									if(child.getAttribute("type")==="application/tlx") {
										resolve(child,model,{extras:config.attributes});
									}
									continue;
								}
								const childclone = child.cloneNode(true);
								shadowRoot.appendChild(childclone);
							}
							shadowRoot.normalize();
							resolve(this,model,{extras:config.attributes});
							if(clone.hasAttribute("bindinputs")) {
								const bindinputs = clone.getAttribute("bindinputs").split(",");
								this.importInputs(...bindinputs);
							}
							
							
							const parameters  = {attributes:config.attributes},
								run = (text=editor ? editor.value : config.text) => {
									text = replaceVariables(text);
									if(clone.content.lastElementChild.tagName==="SCRIPT" && (!clone.content.lastElementChild.hasAttribute("type") || ["text/javascript","application/javascript","javascript"].includes(clone.content.lastElementChild.getAttribute("type")))) {
										const f = new Function("return async function(globalThis,model,RJSON,require,document,parameters,view,editor) { with(model) { " + clone.content.lastElementChild.innerText + " } }")();
										Object.assign(parameters,parse(text,config));
										if(shadowRoot.firstElementChild && shadowRoot.firstElementChild.tagName==="ERROR") {
											shadowRoot.firstElementChild.remove();
										}
										if(config.error) {
											const message = document.createElement("error");
											message.innerText = config.error;
											if(shadowRoot.firstElementChild) {
												shadowRoot.firstElementChild.before(message);
											} else {
												shadowRoot.appendChild(message);
											}
										} else {
											f.call(this,null,this.model,RJSON,require,document,parameters,config.view,editor);
										}
									}
									if(editor) {
										setInterval(() => {
											const lines = (editor.value.match(/.*\n/g)||[]),
												fontsize = getFontWidth(config.view),
												maxwidth = lines.reduce((accum,line) => accum = Math.max(accum,line.length),80) * fontsize,
												scrollwidth = parseInt(config.view.scrollWidth),
												width = maxwidth > scrollwidth ? 80 * fontsize : scrollwidth,
												newwidth = Math.min(parseInt(editor.style.width),Math.min(window.innerWidth-35,width))+"px";
											if(editor.style.width!==newwidth) {
												editor.style.width=newwidth;
											}
										},500);
									}
								};
							this.run = run;
							run(config.text);
							window.addEventListener("resize",() => {
								run()
							});
							while(this.lastChild) {
								this.lastChild.remove();
							}
						})
					}
					setAttribute(name,newValue) {
						const oldValue = this.getAttribute(name);
						super.setAttribute(name,newValue);
						if(observed.includes(name)) {
							this.attributeChangedCallback(name,oldValue,newValue);
						}
					}
					connectedCallback() {
						if(this.connected) {
							this.connected();
						}
						if(this.render) {
							document.resolvingNode = this;
							this.render();
						}
					}
					disconnectedCallback() {
						if(this.disconnected) {
							this.disconnected();
						}
					}
					adoptedCallback() {
						if(this.adopted) {
							this.adopted();
						}
					}
					attributeChangedCallback(name,oldValue,newValue) {
						if(this.attributeChanged) {
							this.attributeChanged(name,oldValue,newValue);
						}
					}
					importInputs(...names) {
						names = names.filter((name) => name!=="")
						let inputs = [].slice.call(this.shadowRoot.querySelectorAll("input[name], select[name], textarea[name]"));
						const model = this.model;
						if(names.length>0) inputs = inputs.filter((input) => names.includes(input.getAttribute("name")));
						inputs.forEach((input) => {
							document.resolvingNode = input;
							const name = input.name,
								existingvalue = model[name];
							let	value = coerce(input.value);
							if(value==="" && input.hasAttribute("default")) {
								value = input.value = coerce(input.getAttribute("default"));
							}
							if((value==null || value==="") && existingvalue!=null) {
								input.setAttribute("value",typeof(existingvalue)==="string" ? existingvalue : JSON.stringify(existingvalue));
								input.value = existingvalue;
							}
							Object.defineProperty(model,name,{enumerable:true,configurable:true,writable:true});
							if(input.type==="radio") {
								if(input.checked) {
									model[name] = value;
								}
								input.addEventListener("click",() => model[name] = coerce(input.value))
								return;
							}
							if(input.type==="checkbox") {
								model[name] = input.checked;
								input.addEventListener("click",() => model[name] = input.checked);
								return;
							}
							if(input.tagName==="SELECT") {
								if(input.multiple) {
									model[name] = [];
								}
								input.addEventListener("change",() => model[name] = input.multiple ? input.value.split(",").map(value => coerce(value)) : coerce(input.value))
								for(let i=0;i<input.options.length;i++) {
									const option = inout.options[i];
									if(option.selected) {
										const value = coerce(option.value);
										if(input.multiple) {
											model[name].push(value)
										} else {
											model[name] = value;
											break;
										}
									}
								}
								return;
							}
							model[name] = value;
							input.addEventListener("change",() => this.model[name] = input.multiple ? input.value.split(",").map(value => coerce(value))  : coerce(input.value))
						})
					}
				}
			);	
			template.remove();
		} catch(error) {
			;
		}
	}
}
	
	const currentScript = document.currentScript,
		scripturl = new URL(currentScript.getAttribute("src")),
		urlbase = `${scripturl.protocol}//${scripturl.host}`,
		templates = currentScript.getAttribute("templates");
	if(!templates) {
		return;
	}
	(async () => {
		await require("https://www.unpkg.com/relaxed-json@1.0.3/relaxed-json.js");
		templates.split(",").forEach((template) => {
			if(template.startsWith("http")||template.includes("/")||template.endsWith(".html")) {
				if(!template.startsWith("http")) {
					template = template.startsWith("/") ? urlbase + template : urlbase + "/" + template;
				}
				if(!template.endsWith(".html")) {
					if(!template.endsWith("/")) {
						template += "/";	
					}
					template += "index.html";
				}
				window.promisedElements.push(new Promise(async (resolve) => {
					const response = await fetch(template),
						html = await response.text(),
						dom =new DOMParser().parseFromString(html,"text/html"),
						tagname = dom.head.firstElementChild.getAttribute("tagname")||dom.head.firstElementChild.id;
					compileTemplate(dom.head.firstElementChild,template);
					resolve(tagname);
				}));
			} else {
				window.promisedElements.push(new Promise(async (resolve) => {
					const el = document.querySelector(`[tagname="${template}"]`);
					compileTemplate(el);
					resolve(el.getAttribute("tagname")||el.id);
				}));
			}
		})
	})();
})();
