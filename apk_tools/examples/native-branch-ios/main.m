#import <UIKit/UIKit.h>

// Owned offline UIKit fixture. Each actual Search records UITextField.text
// in the app container independently of the MCP source and result projection.
static NSString *const BFSAppId = @"com.example.bfsmcp.nativebranches";

static NSURL *BFSLedgerURL(void) {
  NSURL *base = [[[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                      inDomains:NSUserDomainMask] firstObject];
  [[NSFileManager defaultManager] createDirectoryAtURL:base withIntermediateDirectories:YES attributes:nil error:nil];
  return [base URLByAppendingPathComponent:@"branch-ledger.json"];
}

static NSMutableArray *BFSLedger(void) {
  NSData *data = [NSData dataWithContentsOfURL:BFSLedgerURL()];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [parsed isKindOfClass:NSArray.class] ? [parsed mutableCopy] : [NSMutableArray array];
}

static UITextField *BFSField(NSString *identifier, NSString *placeholder) {
  UITextField *field = [[UITextField alloc] init];
  field.accessibilityIdentifier = identifier;
  field.placeholder = placeholder;
  field.borderStyle = UITextBorderStyleRoundedRect;
  field.autocorrectionType = UITextAutocorrectionTypeNo;
  field.autocapitalizationType = UITextAutocapitalizationTypeNone;
  field.spellCheckingType = UITextSpellCheckingTypeNo;
  field.smartDashesType = UITextSmartDashesTypeNo;
  field.smartQuotesType = UITextSmartQuotesTypeNo;
  field.smartInsertDeleteType = UITextSmartInsertDeleteTypeNo;
  field.returnKeyType = UIReturnKeyDone;
  [field.heightAnchor constraintEqualToConstant:48].active = YES;
  return field;
}

static UIButton *BFSButton(NSString *identifier, NSString *title, id target, SEL action) {
  UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
  button.accessibilityIdentifier = identifier;
  [button setTitle:title forState:UIControlStateNormal];
  [button addTarget:target action:action forControlEvents:UIControlEventTouchUpInside];
  [button.heightAnchor constraintEqualToConstant:48].active = YES;
  return button;
}

static void BFSLayout(UIViewController *controller, NSString *identifier, NSArray<UIView *> *children) {
  controller.view.backgroundColor = UIColor.systemBackgroundColor;
  controller.view.accessibilityIdentifier = identifier;
  controller.navigationItem.title = @"";
  controller.navigationItem.backButtonTitle = @"Back";
  UIStackView *stack = [[UIStackView alloc] initWithArrangedSubviews:children];
  stack.axis = UILayoutConstraintAxisVertical;
  stack.spacing = 24;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [controller.view addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.topAnchor constraintEqualToAnchor:controller.view.safeAreaLayoutGuide.topAnchor constant:32],
    [stack.leadingAnchor constraintEqualToAnchor:controller.view.leadingAnchor constant:24],
    [stack.trailingAnchor constraintEqualToAnchor:controller.view.trailingAnchor constant:-24]
  ]];
}

@interface BFSBranchResult : UIViewController
@property(nonatomic, copy) NSString *route;
@property(nonatomic, copy) NSString *resultText;
@end

@implementation BFSBranchResult
- (void)viewDidLoad {
  [super viewDidLoad];
  UILabel *result = [[UILabel alloc] init];
  result.accessibilityIdentifier = [self.route stringByAppendingString:@"_result"];
  result.numberOfLines = 0;
  result.font = [UIFont systemFontOfSize:20];
  result.text = self.resultText;
  BFSLayout(self, [self.route stringByAppendingString:@"_terminal"], @[result]);
}
@end

@interface BFSBranchDetail : UIViewController
@property(nonatomic, copy) NSString *route;
@property(nonatomic, copy) NSString *query;
@property(nonatomic, strong) UITextField *detail;
@end

@implementation BFSBranchDetail
- (void)viewDidLoad {
  [super viewDidLoad];
  self.detail = BFSField([self.route isEqualToString:@"left"] ? @"detail" : @"alternate_detail", @"Detail");
  UIButton *search = BFSButton([self.route stringByAppendingString:@"_search"],
                              [@"Search " stringByAppendingString:self.route], self, @selector(search:));
  BFSLayout(self, [self.route stringByAppendingString:@"_form"], @[self.detail, search]);
}
- (void)search:(id)sender {
  NSString *query = self.query ?: @"";
  NSString *detail = self.detail.text ?: @"";
  NSString *route = self.route ?: @"";
  NSMutableArray *ledger = BFSLedger();
  NSUInteger count = ledger.count + 1;
  [ledger addObject:@{@"query":query, @"detail":detail, @"route":route, @"count":@(count)}];
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:ledger options:0 error:nil];
  if (!encoded || ![encoded writeToURL:BFSLedgerURL() options:NSDataWritingAtomic error:nil]) {
    [NSException raise:@"FixtureLedgerFailure" format:@"Owned fixture ledger could not be written"];
  }
  [self.view endEditing:YES];
  BFSBranchResult *result = [[BFSBranchResult alloc] init];
  result.route = route;
  result.resultText = [NSString stringWithFormat:@"RESULT %@ / %@ / %@ ;COUNT:%lu", query, detail, route, (unsigned long)count];
  [self.navigationController pushViewController:result animated:NO];
}
@end

@interface BFSBranchEntry : UIViewController
@property(nonatomic, strong) UITextField *query;
@property(nonatomic, strong) UISegmentedControl *route;
@end

@implementation BFSBranchEntry
- (void)viewDidLoad {
  [super viewDidLoad];
  self.query = BFSField(@"query", @"Query");
  self.route = [[UISegmentedControl alloc] initWithItems:@[@"left", @"right"]];
  self.route.accessibilityIdentifier = @"route";
  self.route.selectedSegmentIndex = 0;
  UIButton *next = BFSButton(@"next", @"Next", self, @selector(next:));
  BFSLayout(self, @"entry_form", @[self.query, self.route, next]);
}
- (void)next:(id)sender {
  NSString *query = self.query.text ?: @"";
  NSString *route = [self.route titleForSegmentAtIndex:self.route.selectedSegmentIndex];
  [self.view endEditing:YES];
  BFSBranchDetail *detail = [[BFSBranchDetail alloc] init];
  detail.query = query;
  detail.route = route;
  [self.navigationController pushViewController:detail animated:NO];
}
@end

@interface BFSBranchSceneDelegate : UIResponder <UIWindowSceneDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation BFSBranchSceneDelegate
- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  if (![scene isKindOfClass:UIWindowScene.class]) return;
  // A new simulator has no ledger. Startup does not clear an existing ledger.
  if (![[NSFileManager defaultManager] fileExistsAtPath:BFSLedgerURL().path]) {
    [@"[]" writeToURL:BFSLedgerURL() atomically:YES encoding:NSUTF8StringEncoding error:nil];
  }
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[UINavigationController alloc] initWithRootViewController:[[BFSBranchEntry alloc] init]];
  [self.window makeKeyAndVisible];
}
@end

@interface BFSBranchDelegate : UIResponder <UIApplicationDelegate>
@end
@implementation BFSBranchDelegate
- (UISceneConfiguration *)application:(UIApplication *)application configurationForConnectingSceneSession:(UISceneSession *)session options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration = [[UISceneConfiguration alloc] initWithName:@"Default Configuration" sessionRole:session.role];
  configuration.delegateClass = BFSBranchSceneDelegate.class;
  return configuration;
}
@end

int main(int argc, char *argv[]) {
  @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(BFSBranchDelegate.class)); }
}
