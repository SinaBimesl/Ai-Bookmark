console.log("✅ GPT Star content script loaded!");

// کمی صبر کنیم تا DOM کامل بشه
setTimeout(() => {
  const messages = document.querySelectorAll("article");
  console.log(`Found ${messages.length} messages`);

  messages.forEach((msg, index) => {
    // یک wrapper جدید بسازیم
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block"; // تا سایزش دقیقاً اندازه پیام باشه
    wrapper.style.margin = "0"; // فاصله اضافه نداشته باشه
    wrapper.style.padding = "0";

    // پیام اصلی رو منتقل کنیم داخل wrapper
    msg.parentNode.insertBefore(wrapper, msg);
    wrapper.appendChild(msg);

    // ستاره PNG
    const star = document.createElement("img");
    star.src = chrome.runtime.getURL("icons/star-empty.png");
    star.style.width = "20px";
    star.style.height = "20px";
    star.style.cursor = "pointer";

    // ستاره گوشه بالا راست wrapper
    star.style.position = "absolute";
    star.style.top = "0px";
    star.style.right = "250px"; // فاصله 20 پیکسل از پیام
    star.style.zIndex = "9999";

    wrapper.appendChild(star);

    console.log(`⭐ Star added to message #${index + 1}`);
  });
}, 5000);
