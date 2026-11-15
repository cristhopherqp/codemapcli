const someArray = ["Minjeong", 25];

const whoAmI = (someArray) => {
  someArray.forEach(element => {
    console.log(element);
  });

  console.log(`Hello my name is ${someArray[0]} and I have ${someArray[1]}`)
};

whoAmI(someArray);