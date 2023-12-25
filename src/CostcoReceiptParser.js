const chalk = require("chalk");
const { RegexUtils } = require("./RegexUtils");
const { NumberUtils } = require("./NumberUtils");

class CostcoReceiptParser {
  constructor() {
    this.regexUtils = new RegexUtils();
    this.numberUtils = new NumberUtils();

    this.multilineMode = false;
    this.multilineModeCurrentItemName = undefined;
    this.multilineModeCurrentItemIdentifier = undefined;

    this.storeLines = [];
    this.memberIdentifier = [];
    this.receiptIdentifier = undefined;
    this.hasRemainingTransactions = true;
    this.date = undefined;
    this.subtotalAmount = 0;
    this.tax = 0;
    this.totalItemsSoldOnReceipt = 0;
    this.totalItemsSoldCalculated = 0;

    this.itemNameByItemIdentifier = {};
    this.itemIdentifierByItemName = {};
    this.itemIdentifierByDiscountIdentifier = {};
    this.currentLineNumber = 0;
    this.headerLength = 2;
    this.storeIdentifierLength = 5;
  }

  parseLine(line) {
    // The first 2 lines of the receipt are header (date and time) and footer(costco url)
    if(this.currentLineNumber < this.headerLength){
      this.currentLineNumber += 1;
      return;
    }


    // The next 3 (line 3,4,5) lines are the store identifier, street address, and city/state/zip.
    if(this.currentLineNumber < this.storeIdentifierLength) {
      this.storeLines.push(line);
      this.currentLineNumber += 1;
      return;
    }
    // The next 2 lines (7, 8) are Member number information
    if (!this.receiptIdentifier && this.currentLineNumber === this.storeIdentifierLength) {
      this.currentLineNumber += 1;
      this.receiptIdentifier = line;
      return;
    }

    this.currentLineNumber += 1;

    if (this.#parseMemberIdentifier(line)) {
      return;
    }

    // When there are no remaining transactions, grab metadata such as the receipt date and
    // total items sold.
    if (!this.hasRemainingTransactions) {
      this.#parseReceiptMetadata(line);
      return;
    }

    const subtotal = this.#find(line, "SUBTOTAL");
    if (subtotal) {
      this.subtotalAmount = this.#formatAmount(subtotal);
      return;
    }

    const tax = this.#find(line, "TAX");
    if (tax) {
      this.tax = this.#formatAmount(tax);
      return {
        itemIdentifier: "TAX",
        itemName: "TAX",
        amount: this.tax
      };
    }

    const total = this.#find(line, "****TOTAL");
    if (total) {
      this.hasRemainingTransactions = false;
      return;
    }

    // A transaction might span multiple lines.
    //
    // Example:
    //   900091KS
    //   CABERNET
    //   7.99- A
    const multilineTransaction = this.#parseMultilineTransaction(line);
    if (multilineTransaction) {
      return multilineTransaction;
    }

    // A typical transaction spans only one line.
    //
    // Example:
    //   1204135 ORG FIRM TO 6.49
    return this.#parseTransaction(line);
  }

  setMultilineMode(val) {
    this.multilineMode = val;
  }

  isInMultilineMode() {
    return this.multilineMode;
  }

  itemsSoldCheck() {
    const checkPasses = this.totalItemsSoldCalculated === this.totalItemsSoldOnReceipt;
    if (!checkPasses) {
      console.log(chalk.red(`Items sold check failed for ${ this.getDate() }. Calculated items sold (${ this.totalItemsSoldCalculated }) does not equal items sold on receipt (${ this.totalItemsSoldOnReceipt }).\n`));
    }
    return checkPasses;
  }

  getTotalSpent() {
    return this.subtotalAmount + this.tax;
  }

  getDate() {
    return this.date;
  }

  getStore() {
    // this.storeLines might look like:
    //   ['AUSTIN #681', '10401 RESEARCH BLVD', 'AUSTIN,TX78759']
    const splitCityStateZipOnComma = this.storeLines[2].split(",");

    return {
      store: this.storeLines[0],
      street: this.storeLines[1],
      city: splitCityStateZipOnComma[0],
      zipCode: splitCityStateZipOnComma[1].slice(-5),
      state: splitCityStateZipOnComma[1].slice(0, 2),
    };
  }

  // The member number might be on one or two lines. Each page
  // of the receipt starts with the member number.
  //
  // Example:
  //   Member 121549142109
  //   Member
  //   121549142109
  #parseMemberIdentifier(line) {
    if (line.includes("Member")) {
      this.memberIdentifier.push(line);

      // Check if the member number is on the same line
      const hasNumber = /[0-9]/.test(line);
      if (hasNumber) {
        this.memberIdentifier.push(line.replace(/Member/, ""));
      }

      return true;
    }

    // Check if the member identifier length is odd meaning we've
    // just added the 'Member' string and are missing the number
    if (this.memberIdentifier.length % 2 === 1) {
      this.memberIdentifier.push(line);
      return true;
    }
  }

  #parseReceiptMetadata(line) {
    const dateRegex = `(${ this.regexUtils.date() }) ${ this.regexUtils.anything() }`;
    const foundDate = this.regexUtils.matchAll(line, dateRegex);
    if (foundDate.length) {
      this.date = foundDate[1];
      return;
    }

    const totalItemsSold = this.#find(line, "TOTAL NUMBER OF ITEMS SOLD =");
    if (totalItemsSold) {
      this.totalItemsSoldOnReceipt = Number(totalItemsSold);
      return;
    }
  }

  #parseMultilineTransaction(line) {
    // Line doesn't have a dollar amount.
    // This means it's the first line of a multiline entry.
    const hasDollarAmount = /\.[0-9]{2}/.test(line);
    if (!this.multilineMode && !hasDollarAmount) {
      this.multilineMode = true;

      // Remove all letters for the item identifier
      const itemIdentifier = line.replace(/[A-Z]/g, "");
      this.multilineModeCurrentItemIdentifier = itemIdentifier;

      // Remove item identifier and add a space so we can concat the next line
      const itemName = `${ line.replace(/^[A-Z]?[0-9]+/g, "") } `;
      this.multilineModeCurrentItemName = itemName;

      return {
        itemIdentifier: itemIdentifier,
        itemName: itemName,
      };
    }

    // We're in multiline mode and the line doesn't have a dollar amount.
    // This means it's part of the item's name.
    if (this.multilineMode && !hasDollarAmount) {
      const lineWithSpace = `${ line } `;
      this.multilineModeCurrentItemName += lineWithSpace;
      return {
        itemName: lineWithSpace,
      };
    }

    // We're in multiline mode and the line has a dollar amount.
    // This means it's the price paid for the item.
    if (this.multilineMode && hasDollarAmount) {
      const foundAmount = this.regexUtils.matchAll(line, this.#dollarRegex());
      if (foundAmount.length) {
        const amount = this.#formatAmount(foundAmount[1]);
        const { itemName, itemIdentifier } = this.#determineItemNameAndIdentifier(
          amount, this.multilineModeCurrentItemName, this.multilineModeCurrentItemIdentifier
        );

        return {
          itemName: itemName,
          itemIdentifier: itemIdentifier,
          amount: amount
        };
      }
    }
  }

  #parseTransaction(line) {
    const transaction = this.#transactionReplacements(line);

    // A typical line looks like: 1204135 ORG FIRM TO 6.49
    // We capture the numbers at the start (item identifier), capture everything that follows (item name),
    // and capture the dollar amount at the end.
    const transactionRegex = `([0-9]+)(${ this.regexUtils.nonGreedyAnything() })${ this.#dollarRegex() }`;
    const foundTransaction = this.regexUtils.matchAll(transaction, transactionRegex);
    if (foundTransaction.length) {
      const amount = this.#formatAmount(foundTransaction[3]);
      const { itemName, itemIdentifier } = this.#determineItemNameAndIdentifier(
        amount, foundTransaction[2], foundTransaction[1]
      );
      console.log("itemIdentifier: ", itemIdentifier, "itemName: ", itemName, "amount: ", amount);

      return {
        itemIdentifier: itemIdentifier,
        itemName: itemName,
        amount: amount
      }
    }

    return undefined;
  }

  #determineItemNameAndIdentifier(amount, itemName, itemIdentifier) {
    // Remove starting/ending spaces and the `E ` at the beginning which stands for tax-exempt
    const formattedItemName = itemName.trim().replace(/^E /, "");

    // This is a typical bought item.
    //
    // Example:
    //   1204135 ORG FIRM TO 6.49 (bought item - price is positive)
    if (amount > 0) {
      this.totalItemsSoldCalculated++;

      // Maintain a mapping from item identifier to item name and from
      // item name to item identifier to be able to properly identify
      // discounts and returns.
      this.itemNameByItemIdentifier[itemIdentifier] = formattedItemName;
      this.itemIdentifierByItemName[formattedItemName] = itemIdentifier;

      return {
        itemName: formattedItemName,
        itemIdentifier: itemIdentifier
      };
    }

    // If we're here, the price paid for an item is less than zero.
    // We're dealing with a discount or a return.

    // We've seen this item before. This is a discount.
    // Leave the name as is, grab the item identifier for the non-discount version of
    // this item, and prepend it with `D-`.
    //
    // Example:
    //   1204135 ORG FIRM TO 6.49 (bought item)
    //   294721 ORG FIRM TO 2.00- (discount for bought item; different identifier but same name)
    //
    //   Instead of tagging this item with 294721, tag it with D-1204135
    const itemNames = Object.keys(this.itemIdentifierByItemName);
    if (itemNames.includes(formattedItemName)) {
      const itemIdentifierForItemName = this.itemIdentifierByItemName[formattedItemName];

      // A discount might not use the same name as the bought item.
      // Maintain a mapping from the discount identifier to the bought item identifier.
      //
      // Example:
      //   1204135 ORG FIRM TO 6.49 (bought item)
      //   294721 ORG FIRM TO 2.00- (discount for bought item; different identifier but same name)
      //   294721 /0 2.00- (discount for bought item under a different name)
      //
      //   Add a mapping from 294721 to 1204135.
      this.itemIdentifierByDiscountIdentifier[itemIdentifier] = itemIdentifierForItemName;

      return {
        itemName: formattedItemName,
        itemIdentifier: `D-${ itemIdentifierForItemName }`
      };
    }

    // This is a discount going by another name than the bought product.
    // First, we find the bought item identifier for this discount item identifier.
    // Then, we use the bought item identifier to get the item's correct name.
    //
    // Example:
    //   1204135 ORG FIRM TO 6.49 (bought item)
    //   294721 ORG FIRM TO 2.00- (discount for bought item; different identifier but same name)
    //   294721 /0 2.00- (discount for bought item under a different name)
    //
    //   Use ORG FIRM TO as the name and D-1204135 as the item identifier
    const itemIdentifierForDiscount = this.itemIdentifierByDiscountIdentifier[itemIdentifier];
    if (itemIdentifierForDiscount) {
      return {
        itemName: this.itemNameByItemIdentifier[itemIdentifierForDiscount],
        itemIdentifier: `D-${ itemIdentifierForDiscount }`
      };
    }

    // This is a return so reduce the number of items sold by one.
    this.totalItemsSoldCalculated--;
    return {
      itemName: formattedItemName,
      itemIdentifier: `R-${ itemIdentifier }`
    };
  }

  // Some item names have numbers which can merge with the item's
  // price and mess up the total. We add a space after known problematic
  // item names to prevent this issue.
  #transactionReplacements(line) {
    const itemNamesWithNumbers = ["KS WATER 40", "CHNT 10-3/8", "AIRWICK 9+1"];

    for (const itemName of itemNamesWithNumbers) {
      if (line.includes(itemName)) {
        line =  line.replace(itemName, `${ itemName } `);
      }
    }

    // Handle refunds whose format is the following:
    // refundIdentifer /itemIdentifier amount-, e.g.,
    // Original: 1727803 BATH TOWEL 19.98 Y
    // Refund: 318163 /1727803 4.00- (raw: 318163/17278034.00-)
    // If we don't do this it will be difficult to parse the refund amount because how the raw format of the line.
    for(const [itemIdentifier, itemName] of Object.entries(this.itemNameByItemIdentifier)){
      if (line.includes(itemIdentifier)){
        line = line.replace(itemIdentifier, itemName);
      }
    }

    return line;
  }

  #dollarRegex() {
    return `(${ this.regexUtils.dollar() }-?)`;
  }

  #formatAmount(amount) {
    // check if last char is a `-`, this means it's negative (refund)
    if (amount.slice(-1) === "-") {
      return this.numberUtils.dollarToNumber(amount.slice(0, -1), true);
    } else {
      return this.numberUtils.dollarToNumber(amount);
    }
  }

  #find(line, str) {
    const indexOfSubtotal = line.indexOf(str);
    if (indexOfSubtotal > -1) {
      return line.substring(indexOfSubtotal + str.length);
    }
    return undefined;
  }
}

module.exports = { CostcoReceiptParser };
